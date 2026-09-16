-- =====================================================================
-- ASHER Connect — หน้า Logs (เลียนแบบ Logs Explorer ของ Supabase Cloud)
--
-- รวมสี่แหล่งที่เล่าเรื่องเดียวกันคนละมุม ให้เป็นเส้นเวลาเดียว
--   webhook_log    ของดิบที่ผู้ให้บริการยิงเข้ามา   — "มาถึงไหม"
--   bot_decisions  ฐานตัดสินใจอะไร เพราะอะไร        — "ทำไมบอทเงียบ"
--   job            งานที่ออกไปข้างนอกและผลลัพธ์     — "แจ้งออกไปหรือยัง"
--   message        ข้อความที่บันทึกไว้จริง          — "เก็บครบไหม"
--
-- ★ admin เท่านั้น — log มีข้อความลูกค้าดิบ ไม่ใช่ของที่ทุกคนในทีมควรเห็น
-- ★ security definer เพราะ connect_private ไม่เปิดให้ role ปกติอ่าน
--   ด่านสิทธิ์อยู่บรรทัดแรกของทุกฟังก์ชัน (core.current_user_role) ไม่ใช่ที่ชั้นเว็บ
-- =====================================================================

-- ---------------------------------------------------------------------
-- ช่วงเวลา: ค่าเริ่มต้นย้อนหลัง 24 ชั่วโมง
-- ---------------------------------------------------------------------
create or replace function inbox.logs_from(p jsonb)
returns timestamptz language sql immutable as $$
  select coalesce((p->>'from')::timestamptz, now() - interval '24 hours')
$$;

create or replace function inbox.logs_to(p jsonb)
returns timestamptz language sql immutable as $$
  select coalesce((p->>'to')::timestamptz, now() + interval '1 minute')
$$;

-- ---------------------------------------------------------------------
-- เส้นเวลารวม
--
-- p = { from, to, sources:['webhook','decision','job','message'],
--       level:'all'|'problem', search:'ข้อความ', limit:200 }
--
-- level='problem' = เอาเฉพาะแถวที่ควรมีคนดู (error/skipped/บอทไม่ตอบ)
-- เพราะเวลาไล่ปัญหา คนไม่ได้อยากอ่านทุกบรรทัด อยากเห็นเฉพาะที่สะดุด
-- ---------------------------------------------------------------------
create or replace function inbox.logs_timeline(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, inbox, connect_private, core, public
as $$
declare
  v_from    timestamptz := inbox.logs_from(p);
  v_to      timestamptz := inbox.logs_to(p);
  v_src     text[] := coalesce(
              (select array_agg(value::text) from jsonb_array_elements_text(p->'sources')),
              array['webhook','decision','job','message']);
  v_search  text := nullif(btrim(coalesce(p->>'search','')), '');
  v_limit   int  := least(greatest(coalesce((p->>'limit')::int, 200), 1), 1000);
  v_problem bool := coalesce(p->>'level', 'all') = 'problem';
  v_out     jsonb;
begin
  -- ★ ด่านสิทธิ์: admin เท่านั้น — log มีข้อความลูกค้าดิบ
  --   ใช้ core.current_user_role() ซึ่งเป็นตัวที่ระบบนี้ใช้จริง
  --   (inbox.stats_scope ของ sql/018 ยังไม่ได้ลงบนเครื่อง production)
  if coalesce(core.current_user_role(), '') <> 'admin' then
    raise exception 'logs: เปิดให้เฉพาะผู้ดูแลระบบ' using errcode = '42501';
  end if;
  with rows as (
    -- ── ของดิบที่เข้ามา ────────────────────────────────────────────
    select w.received_at as at,
           'webhook'     as source,
           case when w.status = 'failed' then 'error' else 'ok' end as level,
           w.channel_key as channel,
           coalesce(w.payload #>> '{events,0,type}',
                    case when w.payload ? 'entry' then 'messenger_event' else 'event' end) as title,
           coalesce(nullif(w.last_error,''),
                    'mode=' || coalesce(w.payload #>> '{events,0,mode}', '-') ||
                    ' · source=' || coalesce(w.payload #>> '{events,0,source,type}', '-')) as detail,
           jsonb_build_object('status', w.status, 'id', w.id) as extra
      from connect_private.webhook_log w
     where 'webhook' = any(v_src) and w.received_at >= v_from and w.received_at < v_to

    union all
    -- ── ฐานตัดสินใจ ───────────────────────────────────────────────
    select d.decided_at,
           'decision',
           case when d.reply_go then 'ok' else 'warn' end,
           i.name,
           case when d.reply_go then 'บอทจะตอบ' else 'บอทเงียบ: ' || coalesce(d.reply_reason,'-') end,
           'แจ้ง: ' || case when d.notify_go then 'ใช่' else 'ไม่ (' || coalesce(d.notify_reason,'-') || ')' end
             || ' · ข้อความ: ' || left(coalesce(d.text,''), 80),
           jsonb_build_object('reply_go', d.reply_go, 'reply_reason', d.reply_reason,
                              'notify_go', d.notify_go, 'notify_reason', d.notify_reason,
                              'delay_sec', d.delay_sec, 'conversation_id', d.conversation_id)
      from inbox.bot_decisions d
      left join inbox.conversation c on c.id = d.conversation_id
      left join inbox.inbox i on i.id = c.inbox_id
     where 'decision' = any(v_src) and d.decided_at >= v_from and d.decided_at < v_to

    union all
    -- ── งานขาออก ─────────────────────────────────────────────────
    select j.created_at,
           'job',
           case when j.status in ('failed','retry') then 'error'
                when j.status = 'skipped' then 'warn' else 'ok' end,
           j.channel,
           j.kind || ' → ' || j.status,
           coalesce(nullif(j.last_error,''), nullif(j.skip_reason,''),
                    case when j.provider_id is not null then 'provider_id=' || j.provider_id else '-' end),
           jsonb_build_object('id', j.id, 'attempts', j.attempts, 'finished_at', j.finished_at,
                              'skip_reason', j.skip_reason, 'last_error', j.last_error)
      from connect_private.job j
     where 'job' = any(v_src) and j.created_at >= v_from and j.created_at < v_to

    union all
    -- ── ข้อความที่บันทึกไว้ ────────────────────────────────────────
    select m.created_at,
           'message',
           'ok',
           i.name,
           m.sender_type,
           left(coalesce(m.content,''), 120),
           jsonb_build_object('conversation_id', m.conversation_id)
      from inbox.message m
      join inbox.conversation c on c.id = m.conversation_id
      left join inbox.inbox i on i.id = c.inbox_id
     where 'message' = any(v_src) and m.created_at >= v_from and m.created_at < v_to
  ),
  filtered as (
    select * from rows
     where (not v_problem or level in ('warn','error'))
       and (v_search is null
            or title   ilike '%' || v_search || '%'
            or detail  ilike '%' || v_search || '%'
            or coalesce(channel,'') ilike '%' || v_search || '%')
     order by at desc
     limit v_limit
  )
  select jsonb_build_object(
           'from', v_from, 'to', v_to, 'count', count(*),
           'problems', count(*) filter (where level in ('warn','error')),
           'rows', coalesce(jsonb_agg(jsonb_build_object(
                     'at', at, 'source', source, 'level', level,
                     'channel', channel, 'title', title, 'detail', detail, 'extra', extra
                   ) order by at desc), '[]'::jsonb))
    into v_out
    from filtered;

  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- สรุปหัวหน้าจอ: นับตามแหล่งและระดับ ไว้ให้เห็นภาพก่อนไล่อ่านทีละบรรทัด
-- ---------------------------------------------------------------------
create or replace function inbox.logs_summary(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, inbox, connect_private, core, public
as $$
declare
  v_from  timestamptz := inbox.logs_from(p);
  v_to    timestamptz := inbox.logs_to(p);
  v_out   jsonb;
begin
  -- ★ ด่านสิทธิ์: admin เท่านั้น — log มีข้อความลูกค้าดิบ
  --   ใช้ core.current_user_role() ซึ่งเป็นตัวที่ระบบนี้ใช้จริง
  --   (inbox.stats_scope ของ sql/018 ยังไม่ได้ลงบนเครื่อง production)
  if coalesce(core.current_user_role(), '') <> 'admin' then
    raise exception 'logs: เปิดให้เฉพาะผู้ดูแลระบบ' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'webhook_total',  (select count(*) from connect_private.webhook_log w
                        where w.received_at >= v_from and w.received_at < v_to),
    'webhook_failed', (select count(*) from connect_private.webhook_log w
                        where w.received_at >= v_from and w.received_at < v_to and w.status = 'failed'),
    'messages',       (select count(*) from inbox.message m
                        where m.created_at >= v_from and m.created_at < v_to),
    'bot_silent',     (select count(*) from inbox.bot_decisions d
                        where d.decided_at >= v_from and d.decided_at < v_to and not d.reply_go),
    'job_done',       (select count(*) from connect_private.job j
                        where j.created_at >= v_from and j.created_at < v_to and j.status = 'done'),
    'job_skipped',    (select count(*) from connect_private.job j
                        where j.created_at >= v_from and j.created_at < v_to and j.status = 'skipped'),
    'job_failed',     (select count(*) from connect_private.job j
                        where j.created_at >= v_from and j.created_at < v_to and j.status in ('failed','retry')),
    'job_pending',    (select count(*) from connect_private.job j
                        where j.status = 'pending'),
    -- เหตุผลที่ทำให้บอทเงียบบ่อยที่สุด — คำถามแรกที่คนถามเสมอเวลามาดู log
    'top_silent_reasons', (
        select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'n', n) order by n desc), '[]'::jsonb)
          from (select coalesce(d.reply_reason,'-') as reason, count(*) as n
                  from inbox.bot_decisions d
                 where d.decided_at >= v_from and d.decided_at < v_to and not d.reply_go
                 group by 1 order by 2 desc limit 6) t),
    'top_skip_reasons', (
        select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'n', n) order by n desc), '[]'::jsonb)
          from (select coalesce(j.skip_reason,'-') as reason, count(*) as n
                  from connect_private.job j
                 where j.created_at >= v_from and j.created_at < v_to and j.status = 'skipped'
                 group by 1 order by 2 desc limit 6) t)
  ) into v_out;
  return v_out;
end $$;

revoke all on function inbox.logs_timeline(jsonb) from public;
revoke all on function inbox.logs_summary(jsonb)  from public;
grant execute on function inbox.logs_timeline(jsonb) to authenticated;
grant execute on function inbox.logs_summary(jsonb)  to authenticated;

-- ---------------------------------------------------------------------
-- ฮิสโทแกรมตามเวลา — แท่งบอกปริมาณเหตุการณ์ต่อช่วง แยกตามระดับ
--
-- มีไว้ให้เห็น "ตอนไหนมีอะไรผิดปกติ" ก่อนจะไล่อ่านทีละบรรทัด
-- กดแท่งแล้วซูมเข้าไปช่วงนั้นได้ — เหมือน Logs Explorer ของ Supabase
--
-- แบ่งเป็น 72 ช่องเสมอไม่ว่าช่วงกว้างแค่ไหน กราฟจะได้กว้างเท่ากันทุกช่วงเวลา
-- ---------------------------------------------------------------------
create or replace function inbox.logs_histogram(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, inbox, connect_private, core, public
as $$
declare
  v_from  timestamptz := inbox.logs_from(p);
  v_to    timestamptz := inbox.logs_to(p);
  v_src   text[] := coalesce(
            (select array_agg(value::text) from jsonb_array_elements_text(p->'sources')),
            array['webhook','decision','job','message']);
  v_step  interval;
  v_out   jsonb;
begin
  if coalesce(core.current_user_role(), '') <> 'admin' then
    raise exception 'logs: เปิดให้เฉพาะผู้ดูแลระบบ' using errcode = '42501';
  end if;

  v_step := greatest((v_to - v_from) / 72, interval '1 second');

  with ev as (
    select w.received_at as at, case when w.status = 'failed' then 'error' else 'ok' end as level
      from connect_private.webhook_log w
     where 'webhook' = any(v_src) and w.received_at >= v_from and w.received_at < v_to
    union all
    select d.decided_at, case when d.reply_go then 'ok' else 'warn' end
      from inbox.bot_decisions d
     where 'decision' = any(v_src) and d.decided_at >= v_from and d.decided_at < v_to
    union all
    select j.created_at, case when j.status in ('failed','retry') then 'error'
                              when j.status = 'skipped' then 'warn' else 'ok' end
      from connect_private.job j
     where 'job' = any(v_src) and j.created_at >= v_from and j.created_at < v_to
    union all
    select m.created_at, 'ok'
      from inbox.message m
     where 'message' = any(v_src) and m.created_at >= v_from and m.created_at < v_to
  ),
  -- ช่องที่ไม่มีเหตุการณ์ต้องมีอยู่ในผลด้วย ไม่งั้นกราฟจะบีบเวลาที่เงียบทิ้ง
  slots as (select generate_series(v_from, v_to - v_step, v_step) as t),
  -- นับต่อช่องก่อน (group by) แล้วค่อยรวมเป็น array ชั้นนอก
  -- รวมสองขั้นในคำสั่งเดียวไม่ได้ — jsonb_agg กับ group by s.t จะได้แถวละช่อง
  counted as (
    select s.t as at,
           count(e.level) filter (where e.level = 'ok')    as ok,
           count(e.level) filter (where e.level = 'warn')  as warn,
           count(e.level) filter (where e.level = 'error') as error
      from slots s
      left join ev e on e.at >= s.t and e.at < s.t + v_step
     group by s.t
  )
  select jsonb_build_object(
           'from', v_from, 'to', v_to, 'step_seconds', extract(epoch from v_step),
           'buckets', coalesce(jsonb_agg(jsonb_build_object(
             'at', c.at, 'ok', c.ok, 'warn', c.warn, 'error', c.error
           ) order by c.at), '[]'::jsonb))
    into v_out
    from counted c;

  return v_out;
end $$;

revoke all on function inbox.logs_histogram(jsonb) from public;
grant execute on function inbox.logs_histogram(jsonb) to authenticated;
