-- =====================================================================
-- ASHER Connect — Reply Stats  /  0002 functions
-- =====================================================================

-- =====================================================================
-- ส่วนที่ 1 : คณิตศาสตร์เวลาทำการ
-- =====================================================================

-- นับวินาทีระหว่าง p_from..p_to เฉพาะช่วงที่อยู่ในเวลาทำการ
create or replace function inbox.business_seconds(
  p_from timestamptz, p_to timestamptz,
  p_open time, p_close time, p_days int[], p_tz text default 'Asia/Bangkok'
) returns int language plpgsql immutable as $$
declare
  v_total int := 0;
  v_day date; v_end date;
  v_a timestamptz; v_b timestamptz;
  v_guard int := 0;
begin
  if p_from is null or p_to is null or p_to <= p_from then return 0; end if;
  -- ไม่ได้ตั้งเวลาทำการ = นับ 24 ชม.
  if p_open is null or p_close is null then
    return extract(epoch from (p_to - p_from))::int;
  end if;

  v_day := (p_from at time zone p_tz)::date;
  v_end := (p_to   at time zone p_tz)::date;

  while v_day <= v_end and v_guard < 400 loop
    v_guard := v_guard + 1;
    if extract(isodow from v_day)::int = any(p_days) then
      v_a := greatest(p_from, (v_day + p_open)  at time zone p_tz);
      v_b := least   (p_to,   (v_day + p_close) at time zone p_tz);
      if v_b > v_a then
        v_total := v_total + extract(epoch from (v_b - v_a))::int;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return v_total;
end $$;

-- เดินหน้าจาก p_from ไป p_seconds วินาทีทำการ -> ได้เวลาครบกำหนดจริง
-- (ลูกค้าทักตอน 21:00 เวลาครบกำหนด 15 นาที = 09:15 ของวันทำการถัดไป)
create or replace function inbox.business_deadline(
  p_from timestamptz, p_seconds int,
  p_open time, p_close time, p_days int[], p_tz text default 'Asia/Bangkok'
) returns timestamptz language plpgsql immutable as $$
declare
  v_day date; v_left int := p_seconds;
  v_start timestamptz; v_stop timestamptz; v_avail int;
  v_guard int := 0;
begin
  if p_from is null then return null; end if;
  if p_open is null or p_close is null then return p_from + make_interval(secs => p_seconds); end if;

  v_day := (p_from at time zone p_tz)::date;
  while v_guard < 400 loop
    v_guard := v_guard + 1;
    if extract(isodow from v_day)::int = any(p_days) then
      v_start := greatest(p_from, (v_day + p_open) at time zone p_tz);
      v_stop  := (v_day + p_close) at time zone p_tz;
      if v_stop > v_start then
        v_avail := extract(epoch from (v_stop - v_start))::int;
        if v_avail >= v_left then
          return v_start + make_interval(secs => v_left);
        end if;
        v_left := v_left - v_avail;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return null;  -- ไกลเกิน 400 วัน (ไม่ควรเกิดขึ้น)
end $$;

-- หา policy ที่ตรงที่สุด: (project,channel) > (project,*) > (*,channel) > (*,*)
create or replace function inbox.resolve_sla_policy(p_project text, p_channel text)
returns inbox.sla_policy language sql stable as $$
  select p.* from inbox.sla_policy p
  where p.active
    and (p.project     is null or p.project     = p_project)
    and (p.channel_key is null or p.channel_key = p_channel)
  order by (p.project is not null)::int * 2 + (p.channel_key is not null)::int desc
  limit 1
$$;

-- =====================================================================
-- ส่วนที่ 2 : ADAPTER  <<<<<< จุดเดียวที่ต้องแก้ให้ตรงกับ schema จริง
-- =====================================================================
-- แปลง 1 แถวจาก inbox.message ให้เป็นรูปแบบกลางที่ stats layer ใช้:
--   conversation_id, channel_key, project, customer_ref,
--   direction 'in'|'out', actor 'customer'|'bot'|'human',
--   profile_id, text, created_at
-- เขียนด้วย jsonb เพื่อให้ไม่พังถ้าคอลัมน์ไม่มี — แก้ coalesce ให้ตรงของจริง
-- แล้วรัน tests/test_scenario.sql ซ้ำเพื่อยืนยัน
-- =====================================================================
create or replace function inbox.stats_normalize(m inbox.message)
returns jsonb language sql stable as $$
  -- แปลงแถวจริงของ inbox.message ให้เป็นรูปแบบกลางที่ stats_ingest กิน
  --
  -- ★ ไม่ต้องเดาชื่อคอลัมน์อีกแล้ว sender_type มี CHECK บังคับสี่ค่าตายตัว:
  --     contact = ลูกค้า | agent = คน | bot = บอท | system = ประกาศของระบบ (ต้องไม่นับ)
  --   ของเดิมมองหา profile_id/user_id ซึ่งไม่มีอยู่จริง คำตอบของคนเลยตกเป็น bot ทั้งหมด
  --
  -- ★ channel/project/customer_ref ไม่ได้อยู่บนแถวข้อความ ต้องไล่ไปตามสาย
  --     message -> conversation -> inbox -> project   และ  conversation -> contact_identity
  --   ฟังก์ชันนี้จึงเป็น stable ไม่ใช่ immutable เพราะต้องอ่านตารางอื่น
  select jsonb_build_object(
    'message_id',      m.id,
    'conversation_id', m.conversation_id,
    'channel_key',     coalesce(i.channel, 'unknown'),
    'project',         p.code,
    'customer_ref',    ci.external_id,
    'direction',       case when m.sender_type = 'contact' then 'in' else 'out' end,
    'actor',           case m.sender_type
                         when 'contact' then 'customer'
                         when 'bot'     then 'bot'
                         when 'agent'   then 'human'
                         else 'ignore' end,
    -- ตัวตนคนตอบมาจาก sender_id ไม่ใช่ profile_id
    'profile_id',      m.sender_id,
    'text',            m.content,
    -- "ตอบจากแอปของช่องทางเอง" = เป็นคนตอบแต่ไม่มี sender_id (ไม่ได้ส่งผ่านหน้า Connect)
    'is_echo',         (m.sender_type = 'agent' and m.sender_id is null),
    -- follow/unfollow/postback อยู่ในตารางเดียวกันแต่ไม่ใช่บทสนทนา ต้องไม่เปิดรอบ
    'countable',       (m.event_type = 'message' and m.sender_type <> 'system'),
    'created_at',      m.created_at
  )
  from (select 1) _
  left join inbox.conversation c  on c.id = m.conversation_id
  left join inbox.inbox        i  on i.id = c.inbox_id
  left join core.project       p  on p.id = i.project_id
  left join lateral (
    select x.external_id from core.contact_identity x
     where x.contact_id = c.contact_id and x.channel = i.channel limit 1
  ) ci on true
$$;

-- view สำหรับ backfill (ใช้ adapter ตัวเดียวกัน)
create or replace view inbox.v_stats_message as
  select m.created_at, inbox.stats_normalize(m) as norm from inbox.message m;

-- =====================================================================
-- ส่วนที่ 3 : ingest — เปิด/ปิด response window
-- =====================================================================
create or replace function inbox.stats_ingest(n jsonb)
returns void language plpgsql as $$
declare
  v_conv      uuid := nullif(n->>'conversation_id','')::uuid;
  v_at        timestamptz := (n->>'created_at')::timestamptz;
  v_channel   text := n->>'channel_key';
  v_project   text := n->>'project';
  v_text      text := n->>'text';
  v_profile   uuid := nullif(n->>'profile_id','')::uuid;
  v_pol       inbox.sla_policy;
  v_open_id   bigint;
  v_win       inbox.response_window;
  v_src       text;
  v_raw       int;
  v_biz       int;
begin
  -- ข้ามแถวที่ไม่ใช่บทสนทนา (system / follow / unfollow / postback)
  if v_conv is null or v_at is null then return; end if;
  if not coalesce((n->>'countable')::boolean, true) then return; end if;

  -- ---------- ลูกค้าส่งเข้ามา ----------
  if n->>'direction' = 'in' then
    select id into v_open_id from inbox.response_window
     where conversation_id = v_conv and closed_at is null
     order by inbound_at desc limit 1;

    if v_open_id is not null then
      -- ยังไม่มีใครตอบรอบก่อน -> แค่นับว่าลูกค้าทักซ้ำ ไม่เปิดรอบใหม่
      update inbox.response_window
         set inbound_count = inbound_count + 1
       where id = v_open_id;
      return;
    end if;

    v_pol := inbox.resolve_sla_policy(v_project, v_channel);
    insert into inbox.response_window
      (conversation_id, channel_key, project, customer_ref, inbound_at, due_at, policy_id)
    values
      (v_conv, v_channel, v_project, n->>'customer_ref', v_at,
       inbox.business_deadline(v_at, coalesce(v_pol.target_sec,900),
                               v_pol.biz_open, v_pol.biz_close,
                               coalesce(v_pol.biz_days,'{1,2,3,4,5,6,7}'),
                               coalesce(v_pol.tz,'Asia/Bangkok')),
       v_pol.id);
    return;
  end if;

  -- ---------- ฝั่งขาออก ----------
  select * into v_win from inbox.response_window
   where conversation_id = v_conv and closed_at is null and inbound_at <= v_at
   order by inbound_at desc limit 1;

  if not found then
    -- เซลส์ทักไปก่อน / broadcast — ไม่มีรอบให้ปิด ไม่นับ
    return;
  end if;

  -- bot ตอบ: บันทึกไว้แต่ "ไม่ปิดรอบ" เพราะ bot ตอบทันทีเสมอ
  -- ถ้าให้ bot ปิดรอบ SLA จะสวยปลอมทั้งกระดาน
  if n->>'actor' = 'bot' then
    update inbox.response_window
       set first_bot_at = coalesce(first_bot_at, v_at)
     where id = v_win.id;
    return;
  end if;

  -- คนตอบ -> ระบุตัวคนตอบ
  if v_profile is not null then
    v_src := 'workspace';
  else
    select sa.profile_id, 'signature' into v_profile, v_src
      from inbox.signature_alias sa
     where sa.active and v_text is not null and v_text ilike '%'||sa.alias||'%'
     order by length(sa.alias) desc limit 1;

    if v_profile is null then
      v_src := case when coalesce((n->>'is_echo')::boolean,false)
                    then 'page' else 'unassigned' end;
    end if;
  end if;

  v_pol := inbox.resolve_sla_policy(v_win.project, v_win.channel_key);
  v_raw := extract(epoch from (v_at - v_win.inbound_at))::int;
  v_biz := inbox.business_seconds(v_win.inbound_at, v_at,
             v_pol.biz_open, v_pol.biz_close,
             coalesce(v_pol.biz_days,'{1,2,3,4,5,6,7}'),
             coalesce(v_pol.tz,'Asia/Bangkok'));

  update inbox.response_window
     set first_human_at = v_at,
         responder_id   = v_profile,
         responder_src  = v_src,
         raw_sec        = v_raw,
         business_sec   = v_biz,
         closed_at      = v_at,
         policy_id      = coalesce(v_pol.id, policy_id),
         sla_status     = case
                            when v_biz <= coalesce(v_pol.target_sec,900)  then 'met'
                            when v_biz <= coalesce(v_pol.breach_sec,3600) then 'warn'
                            else 'breach' end
   where id = v_win.id;
end $$;

-- =====================================================================
-- ส่วนที่ 4 : trigger  (ห้าม throw — ingestion สำคัญกว่า stats)
-- =====================================================================
create or replace function inbox.stats_on_message() returns trigger
language plpgsql as $$
begin
  begin
    perform inbox.stats_ingest(inbox.stats_normalize(NEW));
  exception when others then
    insert into inbox.stats_error_log (source, payload, sqlstate, message)
    values ('stats_on_message', to_jsonb(NEW), SQLSTATE, SQLERRM);
  end;
  return NEW;
end $$;

drop trigger if exists trg_stats_on_message on inbox.message;
create trigger trg_stats_on_message
  after insert on inbox.message
  for each row execute function inbox.stats_on_message();

-- =====================================================================
-- ส่วนที่ 5 : backfill / คำนวณย้อนหลัง
-- ใช้ตอนเปลี่ยนนิยาม SLA แล้วอยากได้ตัวเลขชุดใหม่ทั้งหมด
-- =====================================================================
create or replace function inbox.rebuild_windows(p_from timestamptz, p_to timestamptz)
returns int language plpgsql as $$
declare v_n int := 0; r record;
begin
  delete from inbox.response_window where inbound_at >= p_from and inbound_at < p_to;
  for r in
    select norm from inbox.v_stats_message
     where created_at >= p_from and created_at < p_to
     order by created_at asc
  loop
    perform inbox.stats_ingest(r.norm);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- =====================================================================
-- ส่วนที่ 6 : mark overdue / abandon
-- =====================================================================
-- รอบที่เปิดค้างเกินกำหนด ให้ขึ้นสถานะ breach ทันทีโดยที่ยังไม่มีใครตอบ
-- (first_human_at is null and sla_status='breach' = "ยังไม่ได้ตอบ")
create or replace function inbox.mark_overdue_windows() returns int
language plpgsql as $$
declare v_n int;
begin
  update inbox.response_window w
     set sla_status = 'breach'
    from inbox.sla_policy p
   where w.closed_at is null
     and w.sla_status = 'open'
     and p.id = w.policy_id
     and inbox.business_seconds(w.inbound_at, now(), p.biz_open, p.biz_close, p.biz_days, p.tz)
         > p.breach_sec;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ปิดรอบที่ค้างนานมากจนถือว่าลูกค้าหายไปแล้ว (ไม่งั้นจะค้างตลอดกาล)
create or replace function inbox.abandon_stale_windows(p_days int default 7) returns int
language plpgsql as $$
declare v_n int;
begin
  update inbox.response_window
     set closed_at = now(), sla_status = 'breach', responder_src = 'unassigned'
   where closed_at is null and inbound_at < now() - make_interval(days => p_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- =====================================================================
-- ส่วนที่ 7 : rollup รายวัน
-- =====================================================================
create or replace function inbox.rollup_agent_daily(p_date date, p_tz text default 'Asia/Bangkok')
returns int language plpgsql as $$
declare
  v_start timestamptz := (p_date::timestamp) at time zone p_tz;
  v_end   timestamptz := ((p_date + 1)::timestamp) at time zone p_tz;
  v_n int;
begin
  delete from inbox.agent_daily_stat where stat_date = p_date;

  insert into inbox.agent_daily_stat (
    stat_date, responder_id, project, channel_key,
    windows_handled, frt_p50_sec, frt_p90_sec, frt_max_sec,
    sla_met, sla_warn, sla_breach, first_active_at, last_active_at)
  select
    p_date,
    w.responder_id,
    coalesce(w.project,'*'),
    coalesce(w.channel_key,'*'),
    count(*) filter (where w.first_human_at is not null),
    percentile_cont(0.5) within group (order by w.business_sec)
      filter (where w.business_sec is not null)::int,
    percentile_cont(0.9) within group (order by w.business_sec)
      filter (where w.business_sec is not null)::int,
    max(w.business_sec),
    count(*) filter (where w.sla_status = 'met'),
    count(*) filter (where w.sla_status = 'warn'),
    count(*) filter (where w.sla_status = 'breach'),
    min(w.first_human_at),
    max(w.first_human_at)
  from inbox.response_window w
  where w.inbound_at >= v_start and w.inbound_at < v_end
  group by 1,2,3,4;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- รวมยอดย้อนหลังหลายวันรวดเดียว
create or replace function inbox.rollup_range(p_from date, p_to date)
returns int language plpgsql as $$
declare d date := p_from; v_n int := 0;
begin
  while d <= p_to loop
    v_n := v_n + inbox.rollup_agent_daily(d);
    d := d + 1;
  end loop;
  return v_n;
end $$;
