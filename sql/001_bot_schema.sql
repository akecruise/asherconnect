-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 — Schema สำหรับย้ายบอทจาก edge function เข้า asher-connect
--
-- รันซ้ำได้ทุกอย่าง (create if not exists / add column if not exists /
-- on conflict do nothing) — รันรอบที่สองต้องไม่เปลี่ยนอะไรและไม่ error
--
-- ★ ไฟล์นี้ไม่แตะคอลัมน์ที่มีข้อมูลอยู่แล้วเลย มีแต่ "เพิ่มของใหม่"
--   สองเรื่องที่ต้องแก้ของเดิมถูกกันไว้ให้คนตัดสิน ดูหัวข้อ "ยังไม่ทำ" ท้ายไฟล์
--
-- ที่มาของค่า seed
--   FB   : CONFIG ใน bot-webhook_fixed.ts  (09-09 21:37)
--   LINE : CONFIG ใน line-webhook.ts v3.1  (09-08 20:30)
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) ของที่ PLAN Phase 1 ขอ และ "มีอยู่แล้ว" — ตรวจว่าอยู่ครบ ไม่สร้างซ้ำ
--
-- สร้างไปแล้วใน migration 20260914120000_asher_connect_inbound_queue
--   connect_private.webhook_log     ของดิบ + คิวขาเข้า + retention 30 วัน
--   connect_private.inbound_event   unique (inbox_id, event_id)
--   connect_private.delivery.payload  jsonb แทน text
--   connect_private.delivery.available_at  = ที่ PLAN เรียกว่า send_after
--
-- ตรงนี้ล้มทั้งไฟล์ถ้าของหาย ดีกว่าไปสร้างของซ้ำซ้อนขึ้นมาอีกชุด
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('connect_private.webhook_log') is null then
    raise exception 'ไม่พบ connect_private.webhook_log — ต้องลง migration 20260914120000 ก่อน';
  end if;
  if to_regclass('connect_private.inbound_event') is null then
    raise exception 'ไม่พบ connect_private.inbound_event — ต้องลง migration 20260914120000 ก่อน';
  end if;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) inbox.conversation — สถานะของบอทที่ยังไม่มีที่อยู่
--
-- ทั้งหมดเป็น add column ล้วน ของเดิมไม่ถูกแตะ
--
-- last_human_reply_at เป็นตัวที่ขาดไม่ได้ที่สุด: decide_reply ทั้งของ FB
-- (humanOwnsConvoHours) และ LINE (humanHoldMin) อ่านค่านี้ตัวเดียว
-- connect_private.case_state.first_human_response_at ใช้แทนไม่ได้
-- เพราะนั่นคือ "ครั้งแรกในชีวิตของเคส" ไม่ใช่ "ครั้งล่าสุด"
-- ───────────────────────────────────────────────────────────────────────────
alter table inbox.conversation
  add column if not exists mode                text,
  add column if not exists last_human_reply_at timestamptz,
  add column if not exists last_bot_reply_at   timestamptz,
  add column if not exists last_notified_at    timestamptz,
  add column if not exists ad_id               text,
  add column if not exists ad_title            text,
  add column if not exists offtopic_count      integer not null default 0,
  add column if not exists offtopic_date       date;

comment on column inbox.conversation.mode is
  'bot = บอทตอบได้ · human = คนรับช่วงแล้ว บอทเงียบ · เป็นคู่แฝดของ bot_active ดูทริกเกอร์ conversation_sync_mode';
comment on column inbox.conversation.last_human_reply_at is
  'ครั้งล่าสุดที่คนตอบ (ไม่ใช่ครั้งแรก) — decide_reply อ่านค่านี้';
comment on column inbox.conversation.ad_id is
  'ติดทั้ง conversation จาก referral (Messenger) หรือ prefix [AD:xxx] (LINE)';

-- ── mode กับ bot_active: ห้ามมีสองความจริง
--
-- asher-web อ่าน bot_active อยู่ 8 แห่ง (หน้า inbox, lib/inbox.ts, สคริปต์ย้ายข้อมูล)
-- จะลบทิ้งไม่ได้ในเฟสนี้ และจะปล่อยให้สองคอลัมน์เดินคนละทางก็ไม่ได้
-- จึงผูกให้ตรงกันด้วยทริกเกอร์ ใครแก้ฝั่งไหนอีกฝั่งตามทันที
--
-- วันที่ asher-web เลิกใช้ bot_active ค่อยลบคอลัมน์กับทริกเกอร์นี้ทิ้งพร้อมกัน
update inbox.conversation
   set mode = case when bot_active then 'bot' else 'human' end
 where mode is null;

-- ★ mode ต้องไม่มี default ของตัวเอง
--
-- ถ้าตั้ง default 'bot' ไว้ ทริกเกอร์จะแยกไม่ออกว่า 'bot' ที่เห็นคือค่าที่ผู้เรียกตั้งใจส่งมา
-- หรือเป็น default ที่ Postgres ใส่ให้ แล้ว insert ที่ส่ง bot_active=false มาจะถูกทับเป็น bot
-- (เจอตอนทดสอบทริกเกอร์ ไม่ใช่ตอนเดา)
--
-- ตัวที่มี default อยู่แล้วคือ bot_active (true) — ปล่อยให้มันเป็นตัวตั้งต้นตัวเดียว
-- แล้ว mode เดินตามเสมอ
alter table inbox.conversation
  alter column mode drop default;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversation_mode_check') then
    alter table inbox.conversation
      add constraint conversation_mode_check check (mode in ('bot','human'));
  end if;
end $$;

create or replace function inbox.conversation_sync_mode()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- ใส่มาทางไหนก็ได้ อีกฝั่งตามให้
    if new.mode is null then new.mode := case when new.bot_active then 'bot' else 'human' end;
    else new.bot_active := (new.mode = 'bot');
    end if;
    return new;
  end if;

  -- แก้ mode → bot_active ตาม · แก้ bot_active → mode ตาม
  -- แก้มาพร้อมกันทั้งคู่ ให้ mode ชนะ เพราะเป็นตัวที่ละเอียดกว่า
  if new.mode is distinct from old.mode then
    new.bot_active := (new.mode = 'bot');
  elsif new.bot_active is distinct from old.bot_active then
    new.mode := case when new.bot_active then 'bot' else 'human' end;
  end if;
  return new;
end $$;

drop trigger if exists conversation_sync_mode on inbox.conversation;
create trigger conversation_sync_mode
  before insert or update on inbox.conversation
  for each row execute function inbox.conversation_sync_mode();

-- ทริกเกอร์เติมค่าให้ก่อนเสมอ จึงบังคับ not null ได้โดยไม่ต้องมี default
alter table inbox.conversation
  alter column mode set not null;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) inbox.bot_schedule — ตารางเวลาที่บอทตอบ (แทน CONFIG.REPLY.schedule / hours)
--
-- ต่อ inbox ไม่ใช่ต่อ project ตามที่สั่ง — project ได้จาก inbox.project_id อยู่แล้ว
-- ถ้าเก็บ project ซ้ำที่นี่ด้วย วันหนึ่งมันจะไม่ตรงกับ inbox
--
-- ช่วงเวลาอ่านแบบเดียวกับ withinHours() ของเดิม
--   start < end   → [start, end)          เช่น 9-19 = เก้าโมงถึงหกโมงเย็น
--   start > end   → ข้ามเที่ยงคืน          เช่น 22-8 = สี่ทุ่มถึงแปดโมงเช้า
--   0 ถึง 24      → ตลอดเวลา
--
-- FB มีสามช่วงและมี mode ต่อช่วง · LINE v3.1 มีช่วงเดียวไม่มี mode
-- ตารางนี้จึงต้องรองรับทั้งสองแบบด้วยโครงเดียว — LINE ก็แค่มีแถวเดียว
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists inbox.bot_schedule (
  id          uuid primary key default gen_random_uuid(),
  inbox_id    uuid not null references inbox.inbox(id) on delete cascade,
  start_hour  integer not null check (start_hour between 0 and 24),
  end_hour    integer not null check (end_hour   between 0 and 24),
  mode        text    not null check (mode in ('immediate','wait_human')),
  wait_min    integer check (wait_min > 0),
  is_active   boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  -- wait_human ต้องบอกว่ารอกี่นาที ไม่งั้นตรรกะไม่รู้จะรอเท่าไร
  constraint bot_schedule_wait_required check (mode <> 'wait_human' or wait_min is not null)
);

create unique index if not exists bot_schedule_window_key
  on inbox.bot_schedule(inbox_id, start_hour, end_hour);

comment on table inbox.bot_schedule is
  'ช่วงเวลาที่บอทตอบ ต่อ inbox · นอกทุกช่วง = บอทไม่ตอบ (ดู bot_config reply.outside_schedule)';


-- ───────────────────────────────────────────────────────────────────────────
-- 4) inbox.bot_config — ค่าที่เหลือทั้งหมดของ CONFIG (key/value ต่อ inbox)
--
-- ทำไมเป็น key/value ไม่ใช่คอลัมน์: CONFIG ของ FB กับ LINE ไม่เท่ากัน
-- และจะงอกอีกเรื่อย ๆ ถ้าเป็นคอลัมน์ ทุกครั้งที่บอทมีเงื่อนไขใหม่ต้อง migration
--
-- ค่าเป็น jsonb เพื่อให้เก็บได้ทั้งเลข ข้อความ boolean และ object (เช่นลายเซ็นทีม)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists inbox.bot_config (
  inbox_id   uuid not null references inbox.inbox(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now(),
  primary key (inbox_id, key)
);

comment on table inbox.bot_config is
  'ค่าเงื่อนไขของบอทต่อ inbox · แทน CONFIG ใน edge function เดิม · ห้ามเก็บ secret (กติกาข้อ 6)';

create or replace function inbox.bot_config_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists bot_config_touch on inbox.bot_config;
create trigger bot_config_touch before update on inbox.bot_config
  for each row execute function inbox.bot_config_touch();

-- อ่านค่าแบบมีค่าสำรอง — ให้ตรรกะฝั่ง SQL เรียกใช้ได้สั้น ๆ
create or replace function inbox.bot_cfg(p_inbox uuid, p_key text, p_default jsonb default null)
returns jsonb
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce((select value from inbox.bot_config where inbox_id = p_inbox and key = p_key), p_default)
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 5) inbox.bot_decisions — บันทึกว่าบอทตัดสินใจอะไรและเพราะอะไร
--
-- ไม่ใช่ log เฉย ๆ — เป็น *เกณฑ์วัดตอน switchover* (PLAN: ต้องตรงกับ cloud ≥ 99%)
-- จึงต้องมีคีย์ที่ไปจับคู่กับฝั่ง cloud ได้ ซึ่งของเดิมไม่มี
-- ใส่ event_id ไว้ด้วยเพราะเป็นสิ่งเดียวที่ทั้งสองฝั่งเห็นตรงกันแน่ ๆ
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists inbox.bot_decisions (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references inbox.conversation(id) on delete cascade,
  message_id      uuid references inbox.message(id) on delete set null,
  event_id        text,
  topic           text,
  reply_go        boolean not null,
  reply_reason    text not null,
  reply_wait_min  integer,
  notify_go       boolean not null,
  notify_reason   text not null,
  notify_action   text check (notify_action in ('send','queue','skip','none')),
  delay_sec       integer not null default 0,
  text            text,
  decided_at      timestamptz not null default now()
);

create index if not exists bot_decisions_conversation_idx
  on inbox.bot_decisions(conversation_id, decided_at desc);
create index if not exists bot_decisions_event_idx
  on inbox.bot_decisions(event_id) where event_id is not null;

comment on column inbox.bot_decisions.text is 'ข้อความลูกค้า 200 ตัวแรก — มีข้อมูลลูกค้าจริง อย่าเปิดให้ role ทั่วไปอ่าน';


-- ───────────────────────────────────────────────────────────────────────────
-- 6) inbox.message_intents — หัวข้อ/stage/objection ที่ถอดจากข้อความ
--
-- port ตรงจากของเดิม ยกเว้นสองอย่าง
--   psid_hash → contact_hash   เพราะที่นี่ไม่ได้มีแต่ psid
--   platform  → channel        ใช้คำเดียวกับทั้ง schema
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists inbox.message_intents (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references inbox.conversation(id) on delete cascade,
  message_id       uuid references inbox.message(id) on delete set null,
  contact_hash     text,
  channel          text not null,
  project          text,
  primary_topic    text,
  primary_l2       text,
  secondary_topics text[] not null default '{}',
  stage            text,
  objection        text,
  budget_signal    text,
  urgency          text,
  confidence       numeric(4,3),
  classifier       text check (classifier in ('claude','keyword')),
  raw_question     text,
  ad_id            text,
  ad_title         text,
  is_new_chat      boolean,
  bot_replied      boolean,
  created_at       timestamptz not null default now()
);

create index if not exists message_intents_conversation_idx
  on inbox.message_intents(conversation_id, created_at desc);
create index if not exists message_intents_topic_idx
  on inbox.message_intents(primary_topic, created_at desc);

comment on column inbox.message_intents.raw_question is
  'ข้อความลูกค้าที่ mask เบอร์/LINE แล้ว 500 ตัวแรก (CONFIG.INSIGHT.maskPII)';


-- ───────────────────────────────────────────────────────────────────────────
-- 7) connect_private.job — outbox ตัวเดียวสำหรับทุกงาน (ยังไม่ต่อสายใช้งาน)
--
-- ทำไมไม่เพิ่มคอลัมน์ใน connect_private.delivery ตามที่ PLAN เขียน:
--   delivery.message_id เป็น primary key และเป็น FK ไป inbox.message
--   แปลว่า "ทุกงานต้องมีข้อความอยู่ในฐานก่อน"
--   แต่งาน generate / classify / notify ยังไม่มีข้อความตอนเข้าคิว
--   การแก้ PK/FK ของตารางที่มีข้อมูลจริง = ต้องถามก่อน (กติกาข้อ 9)
--
-- ตารางนี้จึงถูกสร้างไว้เฉย ๆ ในเฟสนี้ **ยังไม่มีใครเขียนและไม่มีใครอ่าน**
-- delivery ยังเป็นคิวจริงเพียงตัวเดียวต่อไป — ไม่มีช่วงที่มีสองคิวทำงานพร้อมกัน
-- การย้ายของและสลับสายอยู่ใน Phase 4 ตามที่ PLAN วางไว้
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists connect_private.job (
  id              bigint generated always as identity primary key,
  kind            text not null check (kind in ('send','generate','notify','classify','typing')),
  channel         text not null,           -- line · messenger · line_group · telegram · email
  inbox_id        uuid references inbox.inbox(id) on delete cascade,
  conversation_id uuid references inbox.conversation(id) on delete cascade,
  message_id      uuid references inbox.message(id) on delete set null,
  target          text,                    -- psid · line userId · groupId · telegram chat · email
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending'
                  check (status in ('pending','processing','done','failed','uncertain','skipped')),
  attempts        integer not null default 0,
  send_after      timestamptz not null default now(),
  locked_at       timestamptz,
  lease_id        uuid,
  provider_id     text,
  skip_reason     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists job_due_idx
  on connect_private.job(send_after) where status = 'pending';
create index if not exists job_conversation_idx
  on connect_private.job(conversation_id, created_at desc);
-- งานรอของหนึ่งบทสนทนา: ใช้ตอนคนตอบแล้วต้องยกเลิกงานที่บอทจ่อจะส่ง
create index if not exists job_pending_by_conversation_idx
  on connect_private.job(conversation_id, kind) where status in ('pending','processing');

comment on table connect_private.job is
  'outbox ตัวเดียวของทุกงานขาออก · Phase 1 สร้างไว้เฉย ๆ ยังไม่ต่อสาย · ของจริงยังอยู่ที่ connect_private.delivery';


-- ───────────────────────────────────────────────────────────────────────────
-- 8) สิทธิ์ — ตารางใหม่ทุกตัวเป็นของเครื่อง ไม่ใช่ของเบราว์เซอร์
--
-- bot_decisions / message_intents อยู่ใน schema inbox ซึ่ง PostgREST เปิดให้
-- จึงต้องเปิด RLS ไว้โดย *ไม่มี policy* เลย = ไม่มีใครอ่านได้นอกจาก service_role
-- (bot_schedule / bot_config เป็นค่าตั้งค่า ไม่มีข้อมูลลูกค้า แต่ก็ยังไม่เปิดให้ใครอ่าน
--  จนกว่าจะมีหน้าจอตั้งค่าจริง)
-- ───────────────────────────────────────────────────────────────────────────
alter table inbox.bot_schedule     enable row level security;
alter table inbox.bot_config       enable row level security;
alter table inbox.bot_decisions    enable row level security;
alter table inbox.message_intents  enable row level security;
alter table connect_private.job    enable row level security;

revoke all on inbox.bot_schedule, inbox.bot_config, inbox.bot_decisions, inbox.message_intents
  from public, anon, authenticated;
revoke all on connect_private.job from public, anon, authenticated;

grant select, insert, update, delete
  on inbox.bot_schedule, inbox.bot_config, inbox.bot_decisions, inbox.message_intents,
     connect_private.job
  to service_role;

revoke all on function inbox.bot_cfg(uuid, text, jsonb) from public, anon;
grant execute on function inbox.bot_cfg(uuid, text, jsonb) to service_role, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 9) seed — ค่าเริ่มต้นต่อ inbox ตาม CONFIG ของเดิม
--
-- แยกเป็นฟังก์ชันเพื่อให้ inbox ที่เพิ่มทีหลังเรียกใช้ได้ ไม่ต้องมา migration ใหม่
--
-- ★ on conflict do nothing ทุกที่ — รันซ้ำจะไม่ทับค่าที่คนปรับไปแล้ว
--   "รันซ้ำได้" ต้องแปลว่าไม่พังและไม่กลืนของที่แก้ไว้ ไม่ใช่แค่ไม่ error
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.seed_bot_defaults(p_inbox uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_channel text;
begin
  select channel into v_channel from inbox.inbox where id = p_inbox;
  if v_channel is null then raise exception 'ไม่พบ inbox %', p_inbox; end if;

  -- ── ค่าที่ทั้งสองช่องทางใช้เหมือนกัน (STYLE · INSIGHT · DELAY พื้นฐาน · TZ)
  insert into inbox.bot_config(inbox_id, key, value, note) values
    (p_inbox, 'tz',                          '"Asia/Bangkok"',  null),
    (p_inbox, 'style.tone',                  '"warm"',          null),
    (p_inbox, 'style.max_sentences',         '4',               null),
    (p_inbox, 'style.answer_first',          'true',            null),
    (p_inbox, 'style.numbers_required',      'true',            null),
    (p_inbox, 'style.use_emoji',             '"light"',         null),
    (p_inbox, 'style.cta',                   '"when_interested"', null),
    (p_inbox, 'style.ask_contact',           '"when_interested"', null),
    (p_inbox, 'style.greet_new_chat',        'true',            null),
    (p_inbox, 'style.greet_returning',       'false',           null),
    (p_inbox, 'style.resend_brochure_to_returning', 'false',    null),
    (p_inbox, 'style.polite_particle',       '"ค่ะ"',            null),
    (p_inbox, 'insight.enabled',             'true',            null),
    (p_inbox, 'insight.classify_when_silent','true',            null),
    (p_inbox, 'insight.min_confidence',      '0.6',             null),
    (p_inbox, 'insight.mask_pii',            'true',            null),
    (p_inbox, 'insight.project',             '"naii"',          'ของเดิม hardcode ไว้ ควรผูกกับ inbox.project_id ทีหลัง'),
    (p_inbox, 'delay.first_reply_sec',       '15',              null),
    (p_inbox, 'delay.next_reply_sec',        '6',               null),
    (p_inbox, 'delay.jitter_sec',            '4',               'สุ่มบวก 0..N วินาที — ตรรกะต้องรับค่าสุ่มจากข้างนอก ไม่งั้นเทสต์ไม่นิ่ง'),
    (p_inbox, 'delay.typing_indicator',      'true',            null),
    (p_inbox, 'delay.debounce',              'true',            null),
    (p_inbox, 'delay.cancel_if_human_replies','true',           null),
    (p_inbox, 'delay.max_inline_sec',        '50',              'เกินนี้ต้องเข้าคิว ไม่หน่วงค้างในคำขอ (กติกาข้อ 1)'),
    (p_inbox, 'reply.enabled',               'true',            null),
    (p_inbox, 'reply.admin_bypass',          'true',            null),
    (p_inbox, 'reply.respect_convo_mode',    'true',            null),
    (p_inbox, 'reply.reply_to_attachment_only','false',         null),
    (p_inbox, 'reply.outside_schedule',      '"silent"',        'นอกตารางเวลา: silent = เงียบ · ack = ตอบรับสั้น ๆ'),
    (p_inbox, 'reply.offtopic_daily_limit',  '3',               null),
    (p_inbox, 'reply.history_limit',         '12',              null),
    (p_inbox, 'reply.model',                 '"claude-haiku-4-5-20251001"', null),
    (p_inbox, 'notify.enabled',              'true',            null),
    (p_inbox, 'notify.digest_at',            '"09:00"',         null),
    (p_inbox, 'notify.rule',                 '"unanswered"',    null),
    (p_inbox, 'notify.new_chat_gap_hours',   '6',               null),
    (p_inbox, 'notify.always_on_lead',       'true',            null),
    (p_inbox, 'notify.always_on_repeat',     'true',            null),
    (p_inbox, 'notify.always_when_bot_silent','true',           null),
    (p_inbox, 'notify.include_admins',       'false',           null),
    (p_inbox, 'notify.test_mode',            'false',           null),
    (p_inbox, 'notify.channels.line',        'true',            null),
    (p_inbox, 'notify.channels.telegram',    'true',            null),
    (p_inbox, 'notify.channels.email',       'true',            null)
  on conflict (inbox_id, key) do nothing;

  if v_channel = 'messenger' then
    -- ── ค่าเฉพาะ FB (bot-webhook_fixed.ts)
    insert into inbox.bot_config(inbox_id, key, value, note) values
      (p_inbox, 'notify.hours.start',          '19',   'แจ้งทีม 19:00–09:00 · กลางวันทีมอยู่หน้า Business Suite เอง'),
      (p_inbox, 'notify.hours.end',            '9',    null),
      (p_inbox, 'notify.outside_hours',        '"skip"', null),
      (p_inbox, 'notify.leads_ignore_hours',   'false', null),
      (p_inbox, 'notify.remind_after_min',     '0',    '0 = แจ้งครั้งเดียวตอนแชทใหม่ ไม่เตือนซ้ำ'),
      (p_inbox, 'notify.always_on_follow',     'false','Messenger ไม่มี event เพิ่มเพื่อน'),
      (p_inbox, 'notify.watchdog.enabled',     'true', null),
      (p_inbox, 'notify.watchdog.hours.start', '9',    null),
      (p_inbox, 'notify.watchdog.hours.end',   '19',   null),
      (p_inbox, 'notify.watchdog.after_min',   '120',  null),
      (p_inbox, 'notify.watchdog.repeat_every_min', '0', null),
      (p_inbox, 'notify.watchdog.lookback_hours',   '24', null),
      (p_inbox, 'reply.human_hold_min',        '720',  'ของเดิมคือ humanOwnsConvoHours=12 ชม. แปลงเป็นนาทีให้หน่วยเดียวกับ LINE'),
      (p_inbox, 'reply.reply_to_follow',       'false', null),
      (p_inbox, 'team.unknown_label',          '"unknown"', null),
      (p_inbox, 'team.signatures',
        '{"Mint":"[-–(\\[]\\s*(mint|มิ้นท์|มิ้น)\\s*[)\\]]?\\s*$","Kuang":"[-–(\\[]\\s*(kuang|ก้อง|กวง)\\s*[)\\]]?\\s*$","Choosak":"[-–(\\[]\\s*(choosak|ชูศักดิ์|ชู)\\s*[)\\]]?\\s*$"}'::jsonb,
        'Meta ไม่บอกชื่อแอดมินที่ตอบ ต้องเดาจากลายเซ็นท้ายข้อความ · pattern เป็นแบบ POSIX ของ Postgres ไม่ใช่ของ JS')
    on conflict (inbox_id, key) do nothing;

    -- ตารางเวลาของ FB: สามช่วง (CONFIG.REPLY.schedule)
    insert into inbox.bot_schedule(inbox_id, start_hour, end_hour, mode, wait_min, note) values
      (p_inbox, 19, 24, 'wait_human', 30, 'หัวค่ำ: รอคน 30 นาที ไม่มีใครตอบบอทค่อยตอบ'),
      (p_inbox,  0,  6, 'immediate',  null, 'ดึก: บอทตอบเลย'),
      (p_inbox,  6,  9, 'wait_human', 30, 'เช้า: รอคน 30 นาที')
    on conflict (inbox_id, start_hour, end_hour) do nothing;

  elsif v_channel = 'line' then
    -- ── ค่าเฉพาะ LINE (line-webhook.ts v3.1)
    insert into inbox.bot_config(inbox_id, key, value, note) values
      (p_inbox, 'notify.hours.start',          '0',    'LINE แจ้งทีมตลอดเวลา'),
      (p_inbox, 'notify.hours.end',            '24',   null),
      (p_inbox, 'notify.outside_hours',        '"send"', null),
      (p_inbox, 'notify.leads_ignore_hours',   'false', 'ของเดิมไม่มีคีย์นี้ ใส่ค่าที่ไม่เปลี่ยนพฤติกรรม'),
      (p_inbox, 'notify.remind_after_min',     '15',   null),
      (p_inbox, 'notify.always_on_follow',     'true', null),
      (p_inbox, 'notify.watchdog.enabled',     'false','LINE v3.1 ไม่มี watchdog — ค่าที่เหลือใส่ไว้เผื่อเปิดทีหลัง'),
      (p_inbox, 'notify.watchdog.hours.start', '9',    null),
      (p_inbox, 'notify.watchdog.hours.end',   '19',   null),
      (p_inbox, 'notify.watchdog.after_min',   '120',  null),
      (p_inbox, 'notify.watchdog.repeat_every_min', '0', null),
      (p_inbox, 'notify.watchdog.lookback_hours',   '24', null),
      (p_inbox, 'reply.human_hold_min',        '30',   'ของเดิมคือ humanHoldMin=30 นาที'),
      (p_inbox, 'reply.reply_to_follow',       'true', 'เพิ่มเพื่อนใหม่ → ส่งข้อความต้อนรับ ไม่ขึ้นกับตารางเวลา'),
      (p_inbox, 'delay.reply_token_max_sec',   '20',   'หน่วงเกินนี้ reply token หมดอายุ ต้องเปลี่ยนไปใช้ push'),
      (p_inbox, 'line.group_commands',         'true', null),
      (p_inbox, 'line.log_group_ids',          'true', null),
      (p_inbox, 'line.ad_prefix_pattern',      '"^\\[AD:([a-zA-Z0-9_-]+)\\]\\s*"',
        'ข้อความ prefill จากลิงก์โฆษณา เช่น "[AD:naii_carousel_01] สนใจค่ะ"'),
      (p_inbox, 'line.welcome_on_follow',
        to_jsonb('สวัสดีค่ะ ขอบคุณที่เพิ่มเพื่อน Asher นะคะ 🙏' || chr(10) ||
                 'Asher Naii (สุทธิสาร-สะพานควาย) พร้อมอยู่ ตกแต่งครบ 1 ห้องนอน 27-30 ตร.ม. เริ่ม 2.39 ลบ. ผ่อนประมาณ 6,900/เดือน' || chr(10) ||
                 'สอบถามราคา ห้องว่าง หรือนัดชมห้องได้เลยค่ะ'),
        null)
    on conflict (inbox_id, key) do nothing;

    -- ตารางเวลาของ LINE: ช่วงเดียว ข้ามเที่ยงคืน (CONFIG.REPLY.hours 22→8)
    insert into inbox.bot_schedule(inbox_id, start_hour, end_hour, mode, wait_min, note) values
      (p_inbox, 22, 8, 'immediate', null, 'LINE v3.1 มีช่วงเดียว ไม่มีโหมดรอคน')
    on conflict (inbox_id, start_hour, end_hour) do nothing;
  end if;
end $$;

revoke all on function inbox.seed_bot_defaults(uuid) from public, anon, authenticated;
grant execute on function inbox.seed_bot_defaults(uuid) to service_role;

-- ลงค่าให้ inbox ที่มีอยู่ตอนนี้ทุกตัว (รวมตัวที่ปิดอยู่ — วันที่เปิดใช้จะได้มีค่าพร้อม)
do $$
declare r record;
begin
  for r in select id from inbox.inbox loop
    perform inbox.seed_bot_defaults(r.id);
  end loop;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ยังไม่ทำในไฟล์นี้ — รอคนตัดสิน (กติกาข้อ 9)
--
-- 1) ต่อสาย connect_private.job แทน delivery
--    ต้องแก้ primary key / FK ของตารางที่มีข้อมูลจริง แล้วย้ายแถวเดิมมา
--    พร้อมแก้ trigger inbox.enqueue_outbound และ worker ใน server.mjs
--    → อยู่ใน Phase 4 ตาม PLAN อยู่แล้ว
--
-- 2) ลบ inbox.conversation.bot_active
--    asher-web อ่านอยู่ 8 แห่ง ตอนนี้ผูกให้ตรงกับ mode ด้วยทริกเกอร์ไปก่อน
--
-- 3) ย้าย connect_private.webhook_log ไป inbox.webhook_log ตามชื่อใน PLAN
--    ไม่ย้ายเพราะในนั้นมีข้อความลูกค้าดิบ และ schema inbox เปิดให้ PostgREST
-- ═══════════════════════════════════════════════════════════════════════════
