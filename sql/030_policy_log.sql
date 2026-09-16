-- =====================================================================
-- ASHER Connect — สมุดบันทึกการตัดสินใจเรื่องกฎ
--
-- ปัญหาที่แก้: กฎของบอทอยู่ในฐาน เปลี่ยนได้ทันทีโดยไม่ต้อง deploy ซึ่งดี
-- แต่แปลว่าไม่มีอะไรบอกว่า "ใครเปลี่ยน เมื่อไหร่ เพราะอะไร แล้วได้ผลไหม"
--
-- เคสจริงที่ทำให้ต้องมีตารางนี้ (16 ก.ย. 2026):
--   reply.human_hold_min ของ LINE เป็น 30 นาที ส่วน Messenger เป็น 720
--   ไม่มีใครรู้ว่าตั้งใจให้ต่างกัน หรือใครเผลอแก้ไว้ — ไม่มีร่องรอยเลย
--
-- ออกแบบไว้สองชั้น
--   1. trigger เก็บ "อะไรเปลี่ยน" อัตโนมัติ — ไม่พึ่งวินัยคน ลืมไม่ได้
--   2. คนเติม "เพราะอะไร / คาดว่าจะได้อะไร / ไปดูผลเมื่อไหร่" ทีหลังได้
--
-- ★ ไม่ผูกกับ bot_config ด้วย FK เพราะคีย์ถูกลบได้ และเราอยากเก็บประวัติไว้
--   แม้คีย์นั้นจะหายไปแล้ว — ประวัติที่หายเมื่อของถูกลบคือประวัติที่ใช้ไม่ได้
-- =====================================================================

create table if not exists inbox.policy_decision (
  id           bigserial primary key,
  changed_at   timestamptz not null default now(),
  changed_by   uuid,                       -- auth.uid() ตอนที่แก้ · null = แก้จาก psql/สคริปต์
  source       text not null,              -- 'bot_config' | 'bot_schedule' | 'manual'
  inbox_id     uuid,                       -- null = ทั้งระบบ
  key          text not null,              -- เช่น 'reply.human_hold_min'
  old_value    jsonb,
  new_value    jsonb,

  -- สามช่องนี้คนเติมเอง ไม่มี trigger ไหนเดาแทนได้
  reason           text,                   -- ทำไมถึงเปลี่ยน
  expected_effect  text,                   -- คาดว่าจะเกิดอะไร
  review_at        timestamptz,            -- ไปดูผลเมื่อไหร่
  outcome          text,                   -- ผลจริงที่เจอ (เติมตอนรีวิว)
  reviewed_at      timestamptz
);

comment on table inbox.policy_decision is
  'ประวัติการเปลี่ยนกฎบอท — trigger เก็บอัตโนมัติ ส่วนเหตุผล/ผลที่คาด คนเติมเอง';

create index if not exists policy_decision_at_idx  on inbox.policy_decision (changed_at desc);
create index if not exists policy_decision_key_idx on inbox.policy_decision (key, changed_at desc);
-- หาของที่ถึงกำหนดรีวิวแล้วแต่ยังไม่มีใครดู
create index if not exists policy_decision_due_idx on inbox.policy_decision (review_at)
  where outcome is null and review_at is not null;

alter table inbox.policy_decision enable row level security;

-- ---------------------------------------------------------------------
-- trigger: จับทุกการเปลี่ยนค่าใน bot_config
--
-- ★ เขียนเฉพาะตอนค่าเปลี่ยนจริง — update ที่ค่าเท่าเดิมไม่ต้องบันทึก
--   ไม่งั้นสคริปต์ที่ตั้งค่าซ้ำ ๆ จะกลบประวัติจริงจนหาไม่เจอ
-- ---------------------------------------------------------------------
create or replace function inbox.log_bot_config_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, inbox, public
as $$
begin
  if tg_op = 'UPDATE' and old.value is not distinct from new.value then
    return new;
  end if;

  insert into inbox.policy_decision (changed_by, source, inbox_id, key, old_value, new_value)
  values (
    -- auth.uid() ใช้ได้เฉพาะตอนมาจาก PostgREST — จาก psql จะเป็น null ซึ่งถูกแล้ว
    (select nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid,
    'bot_config',
    coalesce(new.inbox_id, old.inbox_id),
    coalesce(new.key, old.key),
    case when tg_op = 'INSERT' then null else old.value end,
    case when tg_op = 'DELETE' then null else new.value end
  );
  return coalesce(new, old);
end $$;

drop trigger if exists bot_config_audit on inbox.bot_config;
create trigger bot_config_audit
  after insert or update or delete on inbox.bot_config
  for each row execute function inbox.log_bot_config_change();

-- ---------------------------------------------------------------------
-- trigger: ตารางเวลา — เก็บทั้งแถวเป็น jsonb เพราะช่วงเวลาหนึ่งช่วงคือของชิ้นเดียว
-- แยกเป็นคอลัมน์ทีละตัวจะอ่านไม่รู้เรื่องว่าช่วงไหนเปลี่ยนเป็นอะไร
-- ---------------------------------------------------------------------
create or replace function inbox.log_bot_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, inbox, public
as $$
declare v_row record := coalesce(new, old);
begin
  insert into inbox.policy_decision (changed_by, source, inbox_id, key, old_value, new_value)
  values (
    (select nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid,
    'bot_schedule',
    v_row.inbox_id,
    'schedule.' || v_row.start_hour || '-' || v_row.end_hour,
    case when tg_op = 'INSERT' then null
         else jsonb_build_object('mode', old.mode, 'wait_min', old.wait_min, 'is_active', old.is_active) end,
    case when tg_op = 'DELETE' then null
         else jsonb_build_object('mode', new.mode, 'wait_min', new.wait_min, 'is_active', new.is_active) end
  );
  return v_row;
end $$;

drop trigger if exists bot_schedule_audit on inbox.bot_schedule;
create trigger bot_schedule_audit
  after insert or update or delete on inbox.bot_schedule
  for each row execute function inbox.log_bot_schedule_change();

-- ---------------------------------------------------------------------
-- เติมเหตุผลให้การเปลี่ยนที่เพิ่งเกิด
--
-- แยกจากตัวการเปลี่ยนโดยตั้งใจ — คนแก้ค่าตอนรีบ แล้วค่อยกลับมาเขียนเหตุผล
-- บังคับให้เขียนเหตุผลพร้อมกันจะจบลงที่ไม่มีใครเขียนเลย
-- ---------------------------------------------------------------------
create or replace function inbox.policy_explain(p jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, inbox, core, public
as $$
declare v_id bigint;
begin
  if coalesce(core.current_user_role(), '') <> 'admin' then
    raise exception 'policy: เปิดให้เฉพาะผู้ดูแลระบบ' using errcode = '42501';
  end if;

  update inbox.policy_decision
     set reason          = coalesce(p->>'reason', reason),
         expected_effect = coalesce(p->>'expected_effect', expected_effect),
         review_at       = coalesce((p->>'review_at')::timestamptz, review_at),
         outcome         = coalesce(p->>'outcome', outcome),
         reviewed_at     = case when p ? 'outcome' then now() else reviewed_at end
   where id = (p->>'id')::bigint
  returning id into v_id;

  if v_id is null then
    raise exception 'policy: ไม่พบรายการ %', p->>'id' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- อ่านประวัติ — ค่าเริ่มต้นเอาของที่ยังไม่มีเหตุผลขึ้นก่อน
-- เพราะนั่นคือของที่ต้องทำอะไรสักอย่าง ส่วนของที่อธิบายแล้วรอได้
-- ---------------------------------------------------------------------
create or replace function inbox.policy_history(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, inbox, core, public
as $$
declare v_out jsonb;
begin
  if coalesce(core.current_user_role(), '') <> 'admin' then
    raise exception 'policy: เปิดให้เฉพาะผู้ดูแลระบบ' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.changed_at desc), '[]'::jsonb)
    into v_out
    from (
      select d.id, d.changed_at, d.source, d.key, d.old_value, d.new_value,
             d.reason, d.expected_effect, d.review_at, d.outcome, d.reviewed_at,
             i.name as inbox_name, pr.role as changed_by_role
        from inbox.policy_decision d
        left join inbox.inbox i on i.id = d.inbox_id
        left join core.profile pr on pr.user_id = d.changed_by
       where (p->>'key' is null or d.key = p->>'key')
         and (coalesce((p->>'unexplained_only')::boolean, false) = false or d.reason is null)
       order by d.changed_at desc
       limit least(greatest(coalesce((p->>'limit')::int, 100), 1), 500)
    ) t;
  return v_out;
end $$;

revoke all on function inbox.policy_explain(jsonb) from public;
revoke all on function inbox.policy_history(jsonb) from public;
grant execute on function inbox.policy_explain(jsonb) to authenticated;
grant execute on function inbox.policy_history(jsonb) to authenticated;
