-- =====================================================================
-- ASHER Connect — ชั้นเก็บข้อมูลที่ย้อนหลังไม่ได้  /  0005
-- =====================================================================
-- สามอย่างในไฟล์นี้มีเหตุผลเดียวกัน: ถ้าไม่เก็บตอนที่ข้อมูลไหลผ่าน
-- ก็ไม่มีทางได้มาอีก ไม่ว่าจะเขียนโค้ดเก่งแค่ไหนทีหลัง
--   1. raw payload ของ webhook
--   2. ที่มาของลูกค้า (first touch) — Messenger ส่งมาเฉพาะครั้งแรก
--   3. ความยินยอมตาม PDPA
-- ยังไม่ใช่ CRM และไม่ใช่ content — เป็นแค่ถังรองข้อมูลดิบ อยู่ใน schema inbox
-- ทั้งหมด การตีความ (ใครเป็นใคร / ref นี้คือคอนเทนต์ตัวไหน) เป็นงานของโมดูลที่มาทีหลัง
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) raw webhook event
-- ---------------------------------------------------------------------
create table if not exists inbox.channel_event (
  id           bigserial primary key,
  channel_key  text not null,
  received_at  timestamptz not null default now(),
  event_key    text,                       -- mid / webhookEventId ไว้กันซ้ำ
  raw          jsonb not null,
  extracted    boolean not null default false,
  note         text
);

create unique index if not exists channel_event_key_uq
  on inbox.channel_event (channel_key, event_key) where event_key is not null;
create index if not exists channel_event_recv_idx on inbox.channel_event (received_at desc);

comment on table inbox.channel_event is
  'payload ดิบของ webhook — มีข้อมูลส่วนบุคคลอยู่ข้างใน ต้องมีนโยบายลบตามอายุ (ดู purge_channel_events)';

-- ---------------------------------------------------------------------
-- 2) ที่มาของลูกค้า
--    acquisition = ครั้งแรกเท่านั้น ห้ามทับ (first touch)
--    acquisition_touch = ทุกครั้งที่กดแอดเข้ามา ไว้ดู last touch / ซ้ำ
-- ---------------------------------------------------------------------
create table if not exists inbox.acquisition (
  id             bigserial primary key,
  channel_key    text not null,
  customer_ref   text not null,
  first_seen_at  timestamptz not null,
  source         text,        -- ADS / SHORTLINK / CUSTOMER_CHAT_PLUGIN / follow / unknown
  ad_id          text,
  ref_code       text,        -- ค่าดิบที่ฝังมากับลิงก์ ห้ามแปลง ห้ามตัด
  event_id       bigint references inbox.channel_event(id) on delete set null,
  raw            jsonb,
  created_at     timestamptz not null default now()
);
create unique index if not exists acquisition_first_uq
  on inbox.acquisition (channel_key, customer_ref);

create table if not exists inbox.acquisition_touch (
  id            bigserial primary key,
  channel_key   text not null,
  customer_ref  text not null,
  at            timestamptz not null,
  source        text,
  ad_id         text,
  ref_code      text,
  event_id      bigint references inbox.channel_event(id) on delete set null
);
create index if not exists acq_touch_idx on inbox.acquisition_touch (channel_key, customer_ref, at desc);
create index if not exists acq_touch_ad_idx on inbox.acquisition_touch (ad_id) where ad_id is not null;

-- ---------------------------------------------------------------------
-- 3) ความยินยอม (PDPA)
--    เก็บเป็นบัญชีเดินสะพัด ไม่ใช่ธงเปิด/ปิด — ต้องตอบได้ว่า
--    "ณ วันที่ยิง broadcast คนนี้ยินยอมอยู่หรือเปล่า"
-- ---------------------------------------------------------------------
create table if not exists inbox.consent_notice (
  version     text primary key,     -- เช่น 'pdpa-2026-09'
  body        text not null,        -- ข้อความที่แสดงให้ลูกค้าเห็นจริง
  effective_from timestamptz not null default now()
);

create table if not exists inbox.consent (
  id             bigserial primary key,
  channel_key    text,
  customer_ref   text,
  contact_id     uuid,              -- เติมทีหลังตอนมี inbox.contact
  purpose        text not null,     -- marketing_broadcast / remarketing / data_processing
  status         text not null check (status in ('granted','withdrawn')),
  at             timestamptz not null default clock_timestamp(),
  channel_of_consent text,          -- line / messenger / web_form / verbal
  notice_version text references inbox.consent_notice(version),
  evidence       jsonb,             -- message id, เลขที่ฟอร์ม, ฯลฯ
  recorded_by    uuid,
  created_at     timestamptz not null default now()
);
create index if not exists consent_lookup_idx
  on inbox.consent (channel_key, customer_ref, purpose, at desc);

-- ห้ามลบแถวใน inbox.consent เด็ดขาด การถอนความยินยอมคือ "เพิ่มแถว withdrawn"
-- ไม่ใช่ลบแถว granted — ไม่งั้นพิสูจน์ย้อนหลังไม่ได้ว่าตอนนั้นมีสิทธิ์ส่ง
create or replace function inbox.consent_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'inbox.consent เป็น append-only — ถอนความยินยอมให้เพิ่มแถว withdrawn';
end $$;

drop trigger if exists trg_consent_no_delete on inbox.consent;
create trigger trg_consent_no_delete
  before delete or update on inbox.consent
  for each row execute function inbox.consent_no_delete();

-- =====================================================================
-- แกะ referral ออกจาก payload
-- =====================================================================
-- Messenger: referral มาได้ 3 ทาง (referral / postback.referral / optin)
--            มาเฉพาะตอนเข้ามาจากแอดหรือลิงก์ ไม่ใช่ทุกข้อความ
-- LINE:      webhook ไม่ได้ส่งที่มาของการ add friend มาให้
--            เก็บได้แค่ postback.data และ event follow เท่านั้น
--            ถ้าต้องการ attribution ของ LINE จริง ๆ ต้องใช้ลิงก์ที่มี
--            พารามิเตอร์ของเราเอง แล้วให้บอทถามหรืออ่านจากข้อความแรก
-- =====================================================================
create or replace function inbox.extract_referral(p_channel_key text, p_raw jsonb)
returns jsonb language plpgsql immutable as $$
declare
  v_out jsonb := '[]'::jsonb;
  e jsonb; m jsonb; r jsonb; ev jsonb;
  v_ref text; v_when timestamptz;
begin
  -- ---------- Messenger ----------
  for e in select jsonb_array_elements(coalesce(p_raw->'entry','[]'::jsonb)) loop
    for m in select jsonb_array_elements(coalesce(e->'messaging','[]'::jsonb)) loop
      r := coalesce(m->'referral', m#>'{postback,referral}');
      v_ref := coalesce(r->>'ref', m#>>'{optin,ref}');

      if r is not null or v_ref is not null then
        v_when := to_timestamp(coalesce((m->>'timestamp')::bigint / 1000.0,
                                        extract(epoch from now())));
        v_out := v_out || jsonb_build_object(
          'customer_ref', m#>>'{sender,id}',
          'at',     v_when,
          'source', coalesce(r->>'source','SHORTLINK'),
          'ad_id',  r->>'ad_id',
          'ref',    v_ref);
      end if;
    end loop;
  end loop;

  -- ---------- LINE ----------
  for ev in select jsonb_array_elements(coalesce(p_raw->'events','[]'::jsonb)) loop
    v_ref := ev#>>'{postback,data}';
    if ev->>'type' = 'follow' or v_ref is not null then
      v_out := v_out || jsonb_build_object(
        'customer_ref', ev#>>'{source,userId}',
        'at',     to_timestamp(coalesce((ev->>'timestamp')::bigint / 1000.0,
                                        extract(epoch from now()))),
        'source', case when ev->>'type' = 'follow' then 'follow' else 'postback' end,
        'ad_id',  null,
        'ref',    v_ref);
    end if;
  end loop;

  return v_out;
end $$;

-- =====================================================================
-- ทางเข้าเดียวที่ Node เรียก: เก็บ raw + แกะที่มา ในทีเดียว
-- รันซ้ำด้วย event_key เดิมไม่เกิดผลข้างเคียง
-- =====================================================================
create or replace function inbox.record_channel_event(
  p_channel_key text, p_raw jsonb, p_event_key text default null)
returns bigint language plpgsql as $$
declare
  v_id bigint; v_item jsonb; v_ref text; v_cid text; v_at timestamptz;
begin
  insert into inbox.channel_event (channel_key, event_key, raw)
  values (p_channel_key, p_event_key, p_raw)
  on conflict (channel_key, event_key) where event_key is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    return null;   -- เคยรับ event นี้ไปแล้ว
  end if;

  for v_item in select jsonb_array_elements(inbox.extract_referral(p_channel_key, p_raw)) loop
    if (v_item->>'customer_ref') is null then continue; end if;
    v_ref := v_item->>'ref';
    v_at  := (v_item->>'at')::timestamptz;

    -- first touch: เขียนได้ครั้งเดียว ห้ามทับ
    insert into inbox.acquisition
      (channel_key, customer_ref, first_seen_at, source, ad_id, ref_code, event_id, raw)
    values
      (p_channel_key, v_item->>'customer_ref', v_at, v_item->>'source',
       v_item->>'ad_id', v_ref, v_id, v_item)
    on conflict (channel_key, customer_ref) do nothing;

    -- ทุกครั้งที่กดเข้ามา
    insert into inbox.acquisition_touch
      (channel_key, customer_ref, at, source, ad_id, ref_code, event_id)
    values
      (p_channel_key, v_item->>'customer_ref', v_at, v_item->>'source',
       v_item->>'ad_id', v_ref, v_id);
  end loop;

  update inbox.channel_event set extracted = true where id = v_id;
  return v_id;
end $$;

-- แกะย้อนหลังจาก event ที่เก็บไว้แล้ว (เช่น หลังแก้ extract_referral)
create or replace function inbox.rebuild_acquisition(p_from timestamptz, p_to timestamptz)
returns int language plpgsql as $$
declare v_n int := 0; r record; v_item jsonb;
begin
  for r in select id, channel_key, raw from inbox.channel_event
            where received_at >= p_from and received_at < p_to order by id
  loop
    for v_item in select jsonb_array_elements(inbox.extract_referral(r.channel_key, r.raw)) loop
      if (v_item->>'customer_ref') is null then continue; end if;
      insert into inbox.acquisition
        (channel_key, customer_ref, first_seen_at, source, ad_id, ref_code, event_id, raw)
      values (r.channel_key, v_item->>'customer_ref', (v_item->>'at')::timestamptz,
              v_item->>'source', v_item->>'ad_id', v_item->>'ref', r.id, v_item)
      on conflict (channel_key, customer_ref) do nothing;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end $$;

-- =====================================================================
-- ความยินยอม
-- =====================================================================
create or replace function inbox.record_consent(
  p_channel_key text, p_customer_ref text, p_purpose text, p_status text,
  p_notice_version text default null, p_channel_of_consent text default null,
  p_evidence jsonb default null, p_recorded_by uuid default null,
  p_at timestamptz default clock_timestamp())
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into inbox.consent (channel_key, customer_ref, purpose, status,
                           notice_version, channel_of_consent, evidence, recorded_by, at)
  values (p_channel_key, p_customer_ref, p_purpose, p_status,
          p_notice_version, p_channel_of_consent, p_evidence, p_recorded_by, p_at)
  returning id into v_id;
  return v_id;
end $$;

-- ยินยอมอยู่หรือเปล่า ณ เวลาที่กำหนด (default = ตอนนี้)
create or replace function inbox.has_consent(
  p_channel_key text, p_customer_ref text, p_purpose text,
  p_at timestamptz default now())
returns boolean language sql stable as $$
  -- ใช้ clock_timestamp ตอนบันทึก เพื่อให้ grant/withdraw ใน transaction เดียวกันเรียงถูก
  select coalesce((
    select c.status = 'granted' from inbox.consent c
     where c.channel_key = p_channel_key
       and c.customer_ref = p_customer_ref
       and c.purpose = p_purpose
       and c.at <= p_at
     order by c.at desc, c.id desc limit 1), false)
$$;

-- =====================================================================
-- นโยบายลบ raw payload
-- เก็บ raw ไว้ตลอดกาลไม่ได้ เพราะมีข้อมูลส่วนบุคคล
-- acquisition กับ consent เป็นข้อมูลสรุปแล้ว เก็บต่อได้
-- =====================================================================
create or replace function inbox.purge_channel_events(p_days int default 180)
returns int language plpgsql as $$
declare v_n int;
begin
  delete from inbox.channel_event
   where received_at < now() - make_interval(days => p_days)
     and extracted;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- cron: 02:00 เวลาไทย
-- select cron.schedule('purge_channel_events','0 19 * * *',
--   $$select inbox.purge_channel_events(180)$$);

insert into inbox.consent_notice (version, body)
select 'pdpa-2026-09', 'ข้อความแจ้งการเก็บข้อมูลส่วนบุคคล — แทนที่ด้วยข้อความจริงที่ใช้'
where not exists (select 1 from inbox.consent_notice where version = 'pdpa-2026-09');
