-- Admin System Status (2026-09-17) — ต่อยอด 202609172025_health.sql ไม่ทำระบบซ้ำ
--
-- 1) กฎ "worker เงียบเกินกำหนด" เป็นคู่ warn/critical ตามแบบกฎเดิม — admin แก้นาทีได้จากหน้าเว็บ
--    ★ ฝั่ง *ประเมิน* อยู่ที่ server.mjs (systemStatus) ไม่ใช่ _health_eval เพราะอายุ worker
--      เป็นสถานะของโพรเซส ฐานไม่เห็น — ตารางนี้ทำหน้าที่เก็บค่าเกณฑ์ให้คนหน้างานแก้เองได้
-- 2) health_queue() — ตัวเลขคิวจาก connect_private.job ที่มีอยู่แล้ว (ไม่สร้างคิวใหม่)
-- 3) health_snapshot รุ่นใหม่ — เพิ่ม last_err ต่อ stage/channel (ตัวรันทีหลังชนะ ตามกฎของ repo)
-- 4) health_rule_save รุ่นใหม่ — เพิ่มด่านตรวจค่าก่อนเขียน (ตัวเลข >= 1 · hour_from < hour_to)

-- kind เพิ่ม 'worker_age' — ชื่อ constraint มาจากการสร้างตารางในไฟล์ก่อน (monitor_rule_kind_check)
do $$ begin
  alter table inbox.monitor_rule drop constraint monitor_rule_kind_check;
exception when undefined_object then null; end $$;
alter table inbox.monitor_rule add constraint monitor_rule_kind_check
  check (kind in ('silence','fail_count','pending_age','tls_days','worker_age'));

insert into inbox.monitor_rule (id, name, node, kind, params, level, notify, hour_from, hour_to) values
  ('inbound-worker-warn',  'Inbound worker เงียบ',     'app',     'worker_age', '{"minutes":1}', 'warn',   false, 0, 24),
  ('inbound-worker-crit',  'Inbound worker เงียบนาน',  'app',     'worker_age', '{"minutes":5}', 'urgent', true,  0, 24),
  ('outbound-worker-warn', 'Outbound worker เงียบ',    'out:bot', 'worker_age', '{"minutes":1}', 'warn',   false, 0, 24),
  ('outbound-worker-crit', 'Outbound worker เงียบนาน', 'out:bot', 'worker_age', '{"minutes":5}', 'urgent', true,  0, 24)
on conflict (id) do nothing;

-- เกณฑ์ที่ server.mjs อ่านไปคำนวณสถานะรวม — แก้จากหน้าเว็บแล้วมีผลทันที (ไม่ต้อง restart)
-- คิวขาออกใช้กฎ pending-warn / pending-urgent เดิมเป็นเกณฑ์ warn/crit ของ "อายุคิวเก่าสุด"
create or replace function inbox.health_thresholds() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'inbound_worker', jsonb_build_object(
      'warn', coalesce((select (params->>'minutes')::int from inbox.monitor_rule where id = 'inbound-worker-warn'),  1),
      'crit', coalesce((select (params->>'minutes')::int from inbox.monitor_rule where id = 'inbound-worker-crit'), 5)),
    'outbound_worker', jsonb_build_object(
      'warn', coalesce((select (params->>'minutes')::int from inbox.monitor_rule where id = 'outbound-worker-warn'), 1),
      'crit', coalesce((select (params->>'minutes')::int from inbox.monitor_rule where id = 'outbound-worker-crit'), 5)),
    'queue_age', jsonb_build_object(
      'warn', coalesce((select (params->>'minutes')::int from inbox.monitor_rule where id = 'pending-warn'),  3),
      'crit', coalesce((select (params->>'minutes')::int from inbox.monitor_rule where id = 'pending-urgent'), 10)))
$$;

revoke all on function inbox.health_thresholds() from public, anon, authenticated;
grant execute on function inbox.health_thresholds() to service_role;

-- ตัวเลขคิวงานของ worker — อ่านอย่างเดียว ไม่ยุ่งคิว
create or replace function inbox.health_queue() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'pending',    (select count(*) from connect_private.job where status = 'pending'),
    'processing', (select count(*) from connect_private.job where status = 'processing'),
    'failed',     (select count(*) from connect_private.job where status = 'failed'),
    'oldest_min', (select round(extract(epoch from (now() - min(send_after))) / 60.0, 1)
                     from connect_private.job where status = 'pending'))
$$;

revoke all on function inbox.health_queue() from public, anon, authenticated;
grant execute on function inbox.health_queue() to service_role;

-- health_snapshot รุ่นใหม่: เพิ่ม last_err (ข้อผิดพลาดล่าสุด) ต่อ stage/channel
-- ที่เหลือเหมือนรุ่น 202609172025 ทุกอย่าง — ตัวรันทีหลังชนะตามกฎของ repo
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
               max(e.detail) filter (where not e.ok)                                   as last_err,
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

-- health_rule_save รุ่นใหม่: เพิ่มด่านตรวจค่า — ตัวเลขเกณฑ์ต้อง >= 1 และช่วงเวลาต้องเรียงถูก
create or replace function inbox.health_rule_save(
  p_id text, p_enabled boolean default null, p_params jsonb default null,
  p_level text default null, p_notify boolean default null,
  p_hour_from int default null, p_hour_to int default null
) returns void language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if inbox.health_role() is distinct from 'admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_hour_from is not null and p_hour_to is not null and p_hour_from >= p_hour_to then
    raise exception 'invalid_rule_hours';
  end if;
  if p_params is not null then
    for k in select jsonb_object_keys(p_params) loop
      if coalesce((p_params -> k)::text, '') !~ '^-?[0-9]+(\.[0-9]+)?$'
         or (p_params ->> k)::numeric < 1 then
        raise exception 'invalid_rule_param';
      end if;
    end loop;
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

notify pgrst, 'reload schema';
