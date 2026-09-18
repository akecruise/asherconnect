-- asher-connect health check: event log + editable rules + snapshot for the admin page.
-- Everything lives in schema "inbox" so it is reachable through the PostgREST profile
-- asher-connect already uses. Safe to re-run.

-- 1. Event log ------------------------------------------------------------
create table if not exists inbox.flow_event (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  stage   text not null,          -- webhook | signature_fail | rpc | reply_queued | reply_sent
                                  -- | telegram | gateway | tls | token | alert | selftest
  channel text,                   -- channel key, e.g. naii-line-oa
  ok      boolean not null default true,
  ref     text,                   -- id that pairs reply_queued with reply_sent
  detail  text
);
create index if not exists flow_event_stage_idx on inbox.flow_event (stage, channel, at desc);
create index if not exists flow_event_at_idx    on inbox.flow_event (at);
create index if not exists flow_event_ref_idx   on inbox.flow_event (ref) where ref is not null;

-- 2. Rules (edit rows here or from the page; no code change needed) ---------
create table if not exists inbox.monitor_rule (
  id        text primary key,
  name      text not null,
  node      text not null,        -- which box on the page this rule colours
  kind      text not null check (kind in ('silence','fail_count','pending_age','tls_days')),
  params    jsonb not null default '{}',
  level     text not null check (level in ('warn','urgent')),
  notify    boolean not null default false,   -- send to Telegram on change
  hour_from int not null default 0  check (hour_from between 0 and 23),
  hour_to   int not null default 24 check (hour_to between 1 and 24),
  enabled   boolean not null default true
);

create table if not exists inbox.monitor_state (
  rule_id text primary key references inbox.monitor_rule(id) on delete cascade,
  firing  boolean not null,
  since   timestamptz not null default now(),
  value   text
);

alter table inbox.flow_event    enable row level security;
alter table inbox.monitor_rule  enable row level security;
alter table inbox.monitor_state enable row level security;
-- no policies: only the security-definer functions below touch these tables.

insert into inbox.monitor_rule (id, name, node, kind, params, level, notify, hour_from, hour_to) values
  ('line-oa-silence',   'ไม่มีข้อความเข้า LINE OA',            'in:naii-line-oa',    'silence',     '{"stage":"webhook","channel":"naii-line-oa","minutes":60}',     'warn',   false, 6, 24),
  ('messenger-silence', 'ไม่มีข้อความเข้า Messenger',          'in:asher-messenger', 'silence',     '{"stage":"webhook","channel":"asher-messenger","minutes":180}', 'warn',   false, 6, 24),
  ('pending-warn',      'คิวตอบกลับค้าง',                       'out:bot',            'pending_age', '{"minutes":3}',                                                 'warn',   false, 0, 24),
  ('pending-urgent',    'คิวตอบกลับค้างนาน',                    'out:bot',            'pending_age', '{"minutes":10}',                                                'urgent', true,  0, 24),
  ('reply-fail',        'บอทส่งข้อความไม่สำเร็จ',               'out:bot',            'fail_count',  '{"stage":"reply_sent","minutes":10,"threshold":3}',             'urgent', true,  0, 24),
  ('token-fail',        'Token ของ LINE/Meta ใช้ไม่ได้',        'out:bot',            'fail_count',  '{"stage":"token","minutes":120,"threshold":1}',                 'urgent', true,  0, 24),
  ('signature-fail',    'Signature ของ webhook ไม่ผ่าน',        'app',                'fail_count',  '{"stage":"signature_fail","minutes":10,"threshold":5}',         'urgent', true,  0, 24),
  ('rpc-fail',          'บันทึกลงฐานข้อมูลไม่สำเร็จ',           'db',                 'fail_count',  '{"stage":"rpc","minutes":10,"threshold":3}',                    'urgent', true,  0, 24),
  ('gateway-fail',      'เข้า inbox.apluscondo.com ไม่ได้',     'gateway',            'fail_count',  '{"stage":"gateway","minutes":5,"threshold":2}',                 'urgent', true,  0, 24),
  ('tls-expiry',        'ใบรับรอง TLS ใกล้หมดอายุ',             'gateway',            'tls_days',    '{"days":14}',                                                   'warn',   true,  0, 24),
  ('telegram-fail',     'ส่ง Telegram ไม่สำเร็จ',               'out:telegram',       'fail_count',  '{"stage":"telegram","minutes":60,"threshold":3}',               'warn',   false, 0, 24)
on conflict (id) do nothing;

-- 3. Who may see / edit -----------------------------------------------------
-- ASSUMPTION: core.profile has columns (user_id uuid, role text).
-- If yours differ, this is the only function to change.
create or replace function inbox.health_role() returns text
language sql stable security definer set search_path = '' as $$
  select p.role::text from core.profile p where p.user_id = auth.uid()
$$;

create or replace function inbox.health_can_view() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(inbox.health_role() in ('manager','admin'), false)
$$;

-- 4. Writing events (service role only) ---------------------------------------
create or replace function inbox.health_log(
  p_stage text, p_channel text default null, p_ok boolean default true,
  p_ref text default null, p_detail text default null
) returns void language sql security definer set search_path = '' as $$
  insert into inbox.flow_event (stage, channel, ok, ref, detail)
  values (p_stage, p_channel, coalesce(p_ok, true), p_ref, left(p_detail, 500))
$$;

create or replace function inbox.health_ping() returns timestamptz
language sql stable security definer set search_path = '' as $$ select now() $$;

-- 5. Rule evaluation ------------------------------------------------------------
create or replace function inbox._health_pending(out n int, out oldest_min numeric)
language sql stable security definer set search_path = '' as $$
  select count(*)::int, round(extract(epoch from now() - min(q.at)) / 60.0, 1)
  from inbox.flow_event q
  where q.stage = 'reply_queued' and q.ref is not null
    and q.at > now() - interval '24 hours'
    and not exists (
      select 1 from inbox.flow_event s
      where s.stage = 'reply_sent' and s.ref = q.ref and s.at >= q.at)
$$;

create or replace function inbox._health_eval()
returns table (o_rule text, o_firing boolean, o_value text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r        inbox.monitor_rule;
  h        int := extract(hour from now() at time zone 'Asia/Bangkok');
  v_last   timestamptz;
  v_start  timestamptz;
  v_n      int;
  v_num    numeric;
begin
  for r in select * from inbox.monitor_rule where enabled loop
    o_rule := r.id; o_firing := false; o_value := null;

    if h < r.hour_from or h >= r.hour_to then
      o_value := 'นอกช่วงเวลาตรวจ';
      return next; continue;
    end if;

    if r.kind = 'silence' then
      select max(e.at) into v_last from inbox.flow_event e
      where e.stage = r.params->>'stage' and e.ok
        and (r.params->>'channel' is null or e.channel = r.params->>'channel');
      -- silence only counts inside today's active window, so a quiet night
      -- does not fire the rule at 06:00 sharp
      v_start := (date_trunc('day', now() at time zone 'Asia/Bangkok')
                  + make_interval(hours => r.hour_from)) at time zone 'Asia/Bangkok';
      if v_last is null then
        o_value := 'ยังไม่มีข้อมูล';
      else
        o_firing := greatest(v_last, v_start) < now() - make_interval(mins => (r.params->>'minutes')::int);
        o_value  := 'ล่าสุด ' || to_char(v_last at time zone 'Asia/Bangkok', 'DD/MM HH24:MI');
      end if;

    elsif r.kind = 'fail_count' then
      select count(*) into v_n from inbox.flow_event e
      where e.stage = r.params->>'stage' and not e.ok
        and (r.params->>'channel' is null or e.channel = r.params->>'channel')
        and e.at > now() - make_interval(mins => (r.params->>'minutes')::int);
      o_firing := v_n >= (r.params->>'threshold')::int;
      o_value  := v_n || ' ครั้งใน ' || (r.params->>'minutes') || ' นาที';

    elsif r.kind = 'pending_age' then
      select p.oldest_min into v_num from inbox._health_pending() p;
      o_firing := coalesce(v_num, 0) >= (r.params->>'minutes')::numeric;
      o_value  := case when v_num is null then 'ไม่มีคิวค้าง' else 'ค้างนานสุด ' || v_num || ' นาที' end;

    elsif r.kind = 'tls_days' then
      select e.detail::numeric into v_num from inbox.flow_event e
      where e.stage = 'tls' and e.ok order by e.at desc limit 1;
      o_firing := v_num is not null and v_num < (r.params->>'days')::numeric;
      o_value  := case when v_num is null then 'ยังไม่ได้ตรวจ' else 'เหลือ ' || v_num || ' วัน' end;
    end if;

    return next;
  end loop;
end $$;

-- Called by asher-connect every minute. Returns the rules whose state changed.
create or replace function inbox.health_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e       record;
  r       inbox.monitor_rule;
  prev    boolean;
  changes jsonb := '[]'::jsonb;
begin
  delete from inbox.monitor_state s
  where not exists (select 1 from inbox.monitor_rule m where m.id = s.rule_id and m.enabled);

  for e in select * from inbox._health_eval() loop
    select s.firing into prev from inbox.monitor_state s where s.rule_id = e.o_rule;
    if not found then prev := null; end if;

    if prev is distinct from e.o_firing then
      insert into inbox.monitor_state (rule_id, firing, since, value)
      values (e.o_rule, e.o_firing, now(), e.o_value)
      on conflict (rule_id) do update
        set firing = excluded.firing, since = now(), value = excluded.value;

      if e.o_firing or prev is not null then
        select * into r from inbox.monitor_rule m where m.id = e.o_rule;
        changes := changes || jsonb_build_object(
          'rule_id', r.id, 'name', r.name, 'level', r.level, 'notify', r.notify,
          'firing', e.o_firing, 'value', e.o_value);
        insert into inbox.flow_event (stage, ok, detail)
        values ('alert', not e.o_firing,
                r.name || case when e.o_firing then ' (' || coalesce(e.o_value, '') || ')'
                               else ' กลับมาปกติ' end);
      end if;
    else
      update inbox.monitor_state s set value = e.o_value where s.rule_id = e.o_rule;
    end if;
  end loop;

  delete from inbox.flow_event where at < now() - interval '30 days';
  return changes;
end $$;

-- 6. Optional hook: numbers for the Sales Workspace box ---------------------------
-- Replace the body with a query on your case table, e.g.
--   select jsonb_build_object('open_cases', count(*), 'overdue', count(*) filter (where ...))
-- The page shows every key it finds. Left empty on purpose: the case table is yours.
create or replace function inbox.health_workspace() returns jsonb
language sql stable security definer set search_path = '' as $$ select '{}'::jsonb $$;

-- 7. Snapshot for the page (manager + admin) -----------------------------------
create or replace function inbox.health_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not inbox.health_can_view() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'now', now(),
    'can_edit', inbox.health_role() = 'admin',
    'stats', (
      select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from (
        select e.stage, e.channel,
               max(e.at)                       as last_at,
               max(e.at) filter (where e.ok)   as last_ok,
               count(*) filter (where e.at > now() - interval '1 hour')                as n_1h,
               count(*) filter (where not e.ok and e.at > now() - interval '1 hour')   as fail_1h,
               count(*) filter (where not e.ok and e.at > now() - interval '24 hours') as fail_24h
        from inbox.flow_event e
        where e.at > now() - interval '7 days' and e.stage not in ('alert','selftest','tls')
        group by e.stage, e.channel) s),
    'tls_days', (select e.detail from inbox.flow_event e
                 where e.stage = 'tls' and e.ok order by e.at desc limit 1),
    'pending', (select jsonb_build_object('n', p.n, 'oldest_min', p.oldest_min)
                from inbox._health_pending() p),
    'rules', (
      select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object(
               'firing', coalesce(s.firing, false), 'since', s.since, 'value', s.value)
               order by m.node, m.id), '[]'::jsonb)
      from inbox.monitor_rule m left join inbox.monitor_state s on s.rule_id = m.id),
    'events', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select e.at, e.stage, e.channel, e.ok, e.detail from inbox.flow_event e
        where e.stage in ('alert','selftest') or not e.ok
        order by e.at desc limit 15) x),
    'workspace', inbox.health_workspace()
  );
end $$;

-- 8. Editing a rule from the page (admin only) ------------------------------------
create or replace function inbox.health_rule_save(
  p_id text, p_enabled boolean default null, p_params jsonb default null,
  p_level text default null, p_notify boolean default null,
  p_hour_from int default null, p_hour_to int default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if inbox.health_role() is distinct from 'admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update inbox.monitor_rule m set
    enabled   = coalesce(p_enabled, m.enabled),
    params    = m.params || coalesce(p_params, '{}'::jsonb),
    level     = coalesce(p_level, m.level),
    notify    = coalesce(p_notify, m.notify),
    hour_from = coalesce(p_hour_from, m.hour_from),
    hour_to   = coalesce(p_hour_to, m.hour_to)
  where m.id = p_id;
  if not found then raise exception 'rule % not found', p_id; end if;
end $$;

-- 9. Permissions -----------------------------------------------------------------
revoke all on function
  inbox.health_role(), inbox.health_can_view(), inbox.health_ping(), inbox.health_tick(),
  inbox.health_log(text, text, boolean, text, text),
  inbox._health_pending(), inbox._health_eval(), inbox.health_workspace(),
  inbox.health_snapshot(),
  inbox.health_rule_save(text, boolean, jsonb, text, boolean, int, int)
from public, anon, authenticated;

grant execute on function
  inbox.health_log(text, text, boolean, text, text), inbox.health_tick(), inbox.health_ping()
to service_role;

grant execute on function
  inbox.health_can_view(), inbox.health_snapshot(),
  inbox.health_rule_save(text, boolean, jsonb, text, boolean, int, int)
to authenticated;

notify pgrst, 'reload schema';
