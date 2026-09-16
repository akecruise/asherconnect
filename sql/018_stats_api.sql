-- =====================================================================
-- ASHER Connect — Reply Stats  /  0003 API (RPC)
-- ทุกฟังก์ชันรับ jsonb คืน jsonb เพื่อเสียบเข้า inbox.connect_api ได้เลย
-- =====================================================================

-- ---------------------------------------------------------------------
-- ADAPTER: ดึง profile ของผู้เรียก
-- แก้ตรงนี้ถ้า core.profile ใช้คอลัมน์อื่นเป็นตัวชี้ auth user
-- ---------------------------------------------------------------------
create or replace function inbox.stats_actor()
returns table (profile_id uuid, role text) language plpgsql stable as $$
begin
  return query
    -- ★ core.profile ไม่มีคอลัมน์ id — PK คือ user_id (ตรงกับ RLS profile_self ด้วย)
    select p.user_id, p.role from core.profile p where p.user_id = auth.uid() and p.is_active;
end $$;

create or replace function inbox.role_rank(p_role text) returns int
language sql immutable as $$
  select case p_role
    when 'admin' then 4
    when 'manager' then 3
    when 'marketing' then 2
    when 'senior_sales' then 2
    when 'sales' then 1
    else 0 end
$$;

-- คืน profile_id ถ้าผู้เรียกเห็นได้แค่ของตัวเอง, คืน null ถ้าเห็นได้ทั้งทีม
create or replace function inbox.stats_scope(p_min_role text default 'sales')
returns uuid language plpgsql stable as $$
declare v_id uuid; v_role text;
begin
  select a.profile_id, a.role into v_id, v_role from inbox.stats_actor() a;
  if v_id is null then
    raise exception 'stats: not authenticated' using errcode = '28000';
  end if;
  if inbox.role_rank(v_role) < inbox.role_rank(p_min_role) then
    raise exception 'stats: role % is not allowed here', v_role using errcode = '42501';
  end if;
  -- sales เห็นเฉพาะตัวเอง ที่เหลือเห็นทั้งทีม
  return case when inbox.role_rank(v_role) <= 1 then v_id else null end;
end $$;

-- ---------------------------------------------------------------------
-- ตัวช่วย: ช่วงเวลา + ตัวกรอง
-- ---------------------------------------------------------------------
create or replace function inbox.stats_from(p jsonb)
returns timestamptz language sql immutable as $$
  select coalesce((p->>'from')::timestamptz, now() - interval '30 days')
$$;
create or replace function inbox.stats_to(p jsonb)
returns timestamptz language sql immutable as $$
  select coalesce((p->>'to')::timestamptz, now())
$$;

-- =====================================================================
-- stats.overview
-- =====================================================================
create or replace function inbox.stats_overview(p jsonb default '{}')
returns jsonb language plpgsql stable as $$
declare
  v_scope uuid := inbox.stats_scope('sales');
  v_from timestamptz := inbox.stats_from(p);
  v_to   timestamptz := inbox.stats_to(p);
  v_out jsonb;
begin
  with w as (
    select * from inbox.response_window
     where inbound_at >= v_from and inbound_at < v_to
       and (v_scope is null or responder_id = v_scope)
       and (p->>'project' is null or project = p->>'project')
       and (p->>'channel' is null or channel_key = p->>'channel')
  ),
  answered as (select * from w where first_human_at is not null)
  select jsonb_build_object(
    'range',            jsonb_build_object('from', v_from, 'to', v_to),
    'windows_total',    (select count(*) from w),
    'windows_answered', (select count(*) from answered),
    'unanswered',       (select count(*) from w where first_human_at is null and closed_at is null),
    'overdue_now',      (select count(*) from w where first_human_at is null
                                and closed_at is null and due_at < now()),
    'frt_p50_sec',      (select percentile_cont(0.5) within group (order by business_sec)::int from answered),
    'frt_p90_sec',      (select percentile_cont(0.9) within group (order by business_sec)::int from answered),
    'frt_avg_sec',      (select avg(business_sec)::int from answered),
    'bot_p50_sec',      (select percentile_cont(0.5) within group
                           (order by extract(epoch from (first_bot_at - inbound_at)))::int
                         from w where first_bot_at is not null),
    'sla_met',          (select count(*) from w where sla_status = 'met'),
    'sla_warn',         (select count(*) from w where sla_status = 'warn'),
    'sla_breach',       (select count(*) from w where sla_status = 'breach'),
    'sla_rate',         (select round(100.0 * count(*) filter (where sla_status='met')
                                      / nullif(count(*) filter (where sla_status <> 'open'),0), 1)
                         from w),
    -- % ของคำตอบที่ยังจับไม่ได้ว่าใครตอบ -> ถ้าสูง leaderboard รายคนยังเชื่อไม่ได้
    'attribution_gap_pct', (select round(100.0 * count(*) filter (where responder_id is null)
                                         / nullif(count(*),0), 1) from answered),
    'by_channel',       (select coalesce(jsonb_agg(x order by x->>'channel_key'), '[]'::jsonb) from (
                           select jsonb_build_object(
                             'channel_key', channel_key,
                             'windows', count(*),
                             'frt_p50_sec', percentile_cont(0.5) within group (order by business_sec)::int,
                             'sla_rate', round(100.0*count(*) filter (where sla_status='met')
                                               / nullif(count(*) filter (where sla_status<>'open'),0),1)
                           ) x from w group by channel_key) s),
    'by_project',       (select coalesce(jsonb_agg(x order by x->>'project'), '[]'::jsonb) from (
                           select jsonb_build_object(
                             'project', coalesce(project,'-'),
                             'windows', count(*),
                             'frt_p50_sec', percentile_cont(0.5) within group (order by business_sec)::int,
                             'sla_rate', round(100.0*count(*) filter (where sla_status='met')
                                               / nullif(count(*) filter (where sla_status<>'open'),0),1)
                           ) x from w group by project) s)
  ) into v_out;
  return v_out;
end $$;

-- =====================================================================
-- stats.agents  (leaderboard)
-- =====================================================================
create or replace function inbox.stats_agents(p jsonb default '{}')
returns jsonb language plpgsql stable as $$
declare
  v_scope uuid := inbox.stats_scope('senior_sales');
  v_from timestamptz := inbox.stats_from(p);
  v_to   timestamptz := inbox.stats_to(p);
begin
  return (
    select coalesce(jsonb_agg(r order by r->'sla_rate' desc nulls last), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'responder_id', w.responder_id,
        'name',         coalesce(coalesce(pr.signature, pu.email), case when w.responder_id is null
                                 then 'ยังระบุตัวไม่ได้' else '—' end),
        'windows',      count(*),
        'frt_p50_sec',  percentile_cont(0.5) within group (order by w.business_sec)::int,
        'frt_p90_sec',  percentile_cont(0.9) within group (order by w.business_sec)::int,
        'sla_met',      count(*) filter (where w.sla_status='met'),
        'sla_breach',   count(*) filter (where w.sla_status='breach'),
        'sla_rate',     round(100.0*count(*) filter (where w.sla_status='met')
                              / nullif(count(*) filter (where w.sla_status<>'open'),0),1),
        'first_active', min(w.first_human_at),
        'last_active',  max(w.first_human_at)
      ) r
      from inbox.response_window w
      left join core.profile pr on pr.user_id = w.responder_id
      left join core."user"  pu on pu.id      = w.responder_id
      where w.inbound_at >= v_from and w.inbound_at < v_to
        and w.first_human_at is not null
        and (v_scope is null or w.responder_id = v_scope)
      group by w.responder_id, pr.signature, pu.email
    ) s
  );
end $$;

-- =====================================================================
-- stats.timeline  (bucket = hour | day | dow_hour)
-- =====================================================================
create or replace function inbox.stats_timeline(p jsonb default '{}')
returns jsonb language plpgsql stable as $$
declare
  v_scope uuid := inbox.stats_scope('sales');
  v_from timestamptz := inbox.stats_from(p);
  v_to   timestamptz := inbox.stats_to(p);
  v_b    text := coalesce(p->>'bucket','day');
  v_tz   text := coalesce(p->>'tz','Asia/Bangkok');
begin
  if v_b not in ('hour','day','week','month','dow_hour') then
    raise exception 'stats: bucket ไม่ถูกต้อง (%)', v_b using errcode = '22023';
  end if;

  if v_b = 'dow_hour' then
    -- heatmap วัน x ชั่วโมง ไว้จัดกะเวร
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'dow', dow, 'hour', hr, 'windows', n, 'frt_p50_sec', p50)), '[]'::jsonb)
            from (
              select extract(isodow from inbound_at at time zone v_tz)::int as dow,
                     extract(hour   from inbound_at at time zone v_tz)::int as hr,
                     count(*) as n,
                     percentile_cont(0.5) within group (order by business_sec)::int as p50
                from inbox.response_window
               where inbound_at >= v_from and inbound_at < v_to
                 and (v_scope is null or responder_id = v_scope)
               group by 1,2) s);
  end if;

  return (select coalesce(jsonb_agg(jsonb_build_object(
            'bucket', bkt, 'windows', n, 'answered', ans,
            'frt_p50_sec', p50, 'sla_rate', rate) order by bkt), '[]'::jsonb)
          from (
            select to_char(date_trunc(v_b, inbound_at at time zone v_tz),
                     case when v_b='hour' then 'YYYY-MM-DD HH24:00' else 'YYYY-MM-DD' end) as bkt,
                   count(*) as n,
                   count(*) filter (where first_human_at is not null) as ans,
                   percentile_cont(0.5) within group (order by business_sec)::int as p50,
                   round(100.0*count(*) filter (where sla_status='met')
                         / nullif(count(*) filter (where sla_status<>'open'),0),1) as rate
              from inbox.response_window
             where inbound_at >= v_from and inbound_at < v_to
               and (v_scope is null or responder_id = v_scope)
             group by 1) s);
end $$;

-- =====================================================================
-- stats.open_windows  (หน้าค้างตอบ real-time — เรียงเกินกำหนดนานสุดก่อน)
-- =====================================================================
create or replace function inbox.stats_open_windows(p jsonb default '{}')
returns jsonb language plpgsql stable as $$
declare v_scope uuid := inbox.stats_scope('sales');
begin
  return (select coalesce(jsonb_agg(x order by (x->>'due_at')), '[]'::jsonb) from (
    select jsonb_build_object(
      'window_id',       w.id,
      'conversation_id', w.conversation_id,
      'channel_key',     w.channel_key,
      'project',         w.project,
      'customer_ref',    w.customer_ref,
      'inbound_at',      w.inbound_at,
      'inbound_count',   w.inbound_count,
      'due_at',          w.due_at,
      'overdue',         (w.due_at < now()),
      'waiting_sec',     extract(epoch from (now() - w.inbound_at))::int,
      'bot_replied',     (w.first_bot_at is not null)
    ) x
    from inbox.response_window w
    where w.closed_at is null and w.first_human_at is null
      and (v_scope is null or true)      -- หน้านี้ทุก role เห็นทั้งคิว (ยังไม่มีเจ้าของ)
      and (p->>'project' is null or w.project = p->>'project')
    limit coalesce((p->>'limit')::int, 200)) s);
end $$;

-- =====================================================================
-- stats.agent_detail
-- =====================================================================
create or replace function inbox.stats_agent_detail(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_scope uuid := inbox.stats_scope('sales');
  v_id uuid := coalesce(nullif(p->>'profile_id','')::uuid, v_scope);
  v_from timestamptz := inbox.stats_from(p);
  v_to   timestamptz := inbox.stats_to(p);
begin
  if v_scope is not null and v_id <> v_scope then
    raise exception 'stats: not allowed to view another agent' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'profile_id', v_id,
    'daily', (select coalesce(jsonb_agg(x order by x->>'date'),'[]'::jsonb) from (
       select jsonb_build_object(
         'date', stat_date, 'windows', sum(windows_handled),
         'frt_p50_sec', max(frt_p50_sec), 'sla_met', sum(sla_met), 'sla_breach', sum(sla_breach)
       ) x from inbox.agent_daily_stat
       where responder_id = v_id and stat_date between v_from::date and v_to::date
       group by stat_date) s),
    'worst', (select coalesce(jsonb_agg(x),'[]'::jsonb) from (
       select jsonb_build_object(
         'window_id', id, 'conversation_id', conversation_id,
         'inbound_at', inbound_at, 'business_sec', business_sec, 'status', sla_status) x
       from inbox.response_window
       where responder_id = v_id and inbound_at >= v_from and inbound_at < v_to
         and sla_status in ('warn','breach')
       order by business_sec desc limit 20) s)
  );
end $$;

-- =====================================================================
-- stats.conversation  (drill-down: timeline ของห้องแชทเดียว)
-- =====================================================================
create or replace function inbox.stats_conversation(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_scope uuid := inbox.stats_scope('sales');
begin
  return (select coalesce(jsonb_agg(x order by x->>'inbound_at'),'[]'::jsonb) from (
    select jsonb_build_object(
      'window_id', w.id, 'inbound_at', w.inbound_at, 'inbound_count', w.inbound_count,
      'first_bot_at', w.first_bot_at, 'first_human_at', w.first_human_at,
      'responder', coalesce(coalesce(pr.signature, pu.email), w.responder_src),
      'responder_src', w.responder_src,
      'raw_sec', w.raw_sec, 'business_sec', w.business_sec, 'status', w.sla_status) x
    from inbox.response_window w
    left join core.profile pr on pr.user_id = w.responder_id
    left join core."user"  pu on pu.id      = w.responder_id
    where w.conversation_id = (p->>'conversation_id')::uuid) s);
end $$;

-- =====================================================================
-- รายงาน Telegram รายวัน (แทนบทบาทของ fbline_report_TG)
-- อ่านจาก rollup ไม่คำนวณสด
-- =====================================================================
create or replace function inbox.stats_telegram_daily(p_date date default (now() at time zone 'Asia/Bangkok')::date - 1)
returns text language plpgsql stable as $$
declare v_txt text; r record; v_tot int; v_rate numeric;
begin
  select sum(windows_handled),
         round(100.0*sum(sla_met)/nullif(sum(sla_met+sla_warn+sla_breach),0),1)
    into v_tot, v_rate
    from inbox.agent_daily_stat where stat_date = p_date;

  v_txt := format('📊 สรุปการตอบ %s'||E'\n'||'รอบที่ตอบ: %s | SLA: %s%%'||E'\n',
                  to_char(p_date,'DD/MM/YYYY'), coalesce(v_tot,0), coalesce(v_rate,0));

  for r in
    select coalesce(coalesce(pr.signature, pu.email),'ยังระบุตัวไม่ได้') as name,
           sum(a.windows_handled) w,
           max(a.frt_p50_sec) p50,
           round(100.0*sum(a.sla_met)/nullif(sum(a.sla_met+a.sla_warn+a.sla_breach),0),1) rate
      from inbox.agent_daily_stat a
      left join core.profile pr on pr.user_id = a.responder_id
      left join core."user"  pu on pu.id      = a.responder_id
     where a.stat_date = p_date
     group by 1 order by rate desc nulls last
  loop
    v_txt := v_txt || format(E'\n• %s — %s รอบ | ตอบกลาง %s นาที | SLA %s%%',
               r.name, r.w, round(coalesce(r.p50,0)/60.0,1), coalesce(r.rate,0));
  end loop;
  return v_txt;
end $$;

-- =====================================================================
-- ต่อเข้า inbox.connect_api
-- เพิ่ม branch พวกนี้ใน CASE ของ connect_api เดิม:
-- =====================================================================
--   when 'stats.overview'      then return inbox.stats_overview(p_data);
--   when 'stats.agents'        then return inbox.stats_agents(p_data);
--   when 'stats.timeline'      then return inbox.stats_timeline(p_data);
--   when 'stats.open_windows'  then return inbox.stats_open_windows(p_data);
--   when 'stats.agent_detail'  then return inbox.stats_agent_detail(p_data);
--   when 'stats.conversation'  then return inbox.stats_conversation(p_data);
-- =====================================================================
