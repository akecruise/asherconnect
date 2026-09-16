-- =====================================================================
-- ASHER Connect — Reply Stats  /  0001 schema
-- =====================================================================
-- หน่วยวัดหลักคือ "response window" = 1 รอบ (ลูกค้าถาม -> คนตอบ)
-- ไม่ใช่ทั้ง conversation เพราะ 1 ห้องแชทมีหลายรอบถาม-ตอบ
-- =====================================================================

create schema if not exists inbox;

-- ---------------------------------------------------------------------
-- 1) นโยบาย SLA + เวลาทำการ  (ต่อ project / channel, มี fallback)
-- ---------------------------------------------------------------------
create table if not exists inbox.sla_policy (
  id          bigserial primary key,
  project     text,                    -- null = ใช้กับทุก project
  channel_key text,                    -- null = ใช้กับทุก channel
  target_sec  int  not null default 900,    -- 15 นาที = met
  warn_sec    int  not null default 1800,   -- 30 นาที = warn
  breach_sec  int  not null default 3600,   -- เกิน 60 นาที = breach
  biz_open    time,                         -- null = นับ 24 ชม. ไม่หยุดนาฬิกา
  biz_close   time,
  biz_days    int[] not null default '{1,2,3,4,5,6,7}',  -- ISO: 1=จันทร์ .. 7=อาทิตย์
  tz          text not null default 'Asia/Bangkok',
  active      boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create unique index if not exists sla_policy_scope_uq
  on inbox.sla_policy (coalesce(project,'*'), coalesce(channel_key,'*'))
  where active;

-- ---------------------------------------------------------------------
-- 2) map ลายเซ็นท้ายข้อความ -> พนักงาน
--    ใช้ช่วง transition ที่เซลส์ยังตอบจาก Facebook Page (มาเป็น is_echo
--    ไม่มี user id ติดมา) เช่น '-มิ้นท์'
-- ---------------------------------------------------------------------
create table if not exists inbox.signature_alias (
  alias       text primary key,
  profile_id  uuid not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3) response window — ตารางหลัก
-- ---------------------------------------------------------------------
create table if not exists inbox.response_window (
  id               bigserial primary key,
  conversation_id  uuid        not null,   -- inbox.conversation.id เป็น uuid
  channel_key      text        not null,
  project          text,
  customer_ref     text,                       -- psid / lineUserId เผื่อ debug

  inbound_at       timestamptz not null,       -- ลูกค้าเข้ามา (ข้อความแรกของรอบ)
  inbound_count    int         not null default 1,  -- ลูกค้าทักซ้ำกี่ครั้งก่อนได้คำตอบ
  first_bot_at     timestamptz,
  first_human_at   timestamptz,

  responder_id     uuid,
  responder_src    text check (responder_src in
                     ('workspace','signature','page','bot','unassigned')),

  raw_sec          int,      -- วินาทีจริง (นาฬิกาแขวนผนัง)
  business_sec     int,      -- วินาทีเฉพาะในเวลาทำการ  <- ตัวที่ใช้ตัดสิน SLA
  due_at           timestamptz,   -- ครบกำหนด target ตามเวลาทำการ (ไว้เรียง overdue)

  sla_status       text not null default 'open'
                     check (sla_status in ('open','met','warn','breach')),
  policy_id        bigint,

  closed_at        timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists rw_inbound_idx    on inbox.response_window (inbound_at desc);
create index if not exists rw_responder_idx  on inbox.response_window (responder_id, inbound_at desc);
create index if not exists rw_open_idx       on inbox.response_window (due_at)
                                             where sla_status = 'open';
create index if not exists rw_conv_open_idx  on inbox.response_window (conversation_id)
                                             where closed_at is null;
create index if not exists rw_scope_idx      on inbox.response_window (project, channel_key, inbound_at desc);

comment on column inbox.response_window.business_sec is
  'วินาทีที่นับเฉพาะในเวลาทำการ — ใช้ตัวนี้ตัดสิน SLA ทุกที่ ไม่ใช่ raw_sec';

-- ---------------------------------------------------------------------
-- 4) rollup รายวัน — dashboard/Telegram อ่านจากตารางนี้ ไม่ query ดิบ
-- ---------------------------------------------------------------------
create table if not exists inbox.agent_daily_stat (
  stat_date        date not null,
  responder_id     uuid,                -- null = ยังหาคนตอบไม่เจอ (attribution gap)
  project          text not null default '*',
  channel_key      text not null default '*',

  windows_handled  int not null default 0,
  msgs_sent        int not null default 0,
  frt_p50_sec      int,
  frt_p90_sec      int,
  frt_max_sec      int,
  sla_met          int not null default 0,
  sla_warn         int not null default 0,
  sla_breach       int not null default 0,
  first_active_at  timestamptz,
  last_active_at   timestamptz,
  refreshed_at     timestamptz not null default now(),

  id bigserial primary key
);
-- responder_id เป็น null ได้ (คำตอบที่ยังจับไม่ได้ว่าใครตอบ) จึงใช้ unique index
-- แทน primary key เพื่อไม่ให้ null กลายเป็น not null
create unique index if not exists ads_uq on inbox.agent_daily_stat
  (stat_date, coalesce(responder_id,'00000000-0000-0000-0000-000000000000'::uuid), project, channel_key);

create index if not exists ads_date_idx on inbox.agent_daily_stat (stat_date desc);

-- ---------------------------------------------------------------------
-- 5) error log ของ stats layer
--    trigger ห้าม throw เด็ดขาด ถ้าคำนวณ stats พังต้องไม่ทำให้ webhook
--    รับข้อความไม่ได้ -> จับ exception แล้วมาลงตารางนี้แทน
-- ---------------------------------------------------------------------
create table if not exists inbox.stats_error_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  source     text,
  payload    jsonb,
  sqlstate   text,
  message    text
);
create index if not exists sel_at_idx on inbox.stats_error_log (at desc);
