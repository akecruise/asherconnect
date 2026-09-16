-- =====================================================================
-- ASHER Connect — ตัวเชื่อมสำหรับโมดูลที่จะมาทีหลัง  /  0006
-- =====================================================================
-- ไฟล์นี้ไม่ได้ทำ CRM และไม่ได้ทำ content — ทำแค่สามอย่างที่ทำให้
-- วันที่สร้างโมดูลพวกนั้น ไม่ต้องกลับมาแก้ inbox อีก
--   1. outbox  — inbox ประกาศเหตุการณ์ โมดูลอื่นมาอ่านเอา
--   2. id ที่นิ่ง — ของที่มาทีหลังชี้กลับมาที่ข้อความต้นทางได้
--   3. นโยบายเก็บข้อมูล — ข้อความต้องอยู่นานกว่า payload ดิบ
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) id ที่นิ่ง
--    เพิ่มแบบไม่ทำลายของเดิม รันซ้ำได้
-- ---------------------------------------------------------------------
alter table inbox.message
  add column if not exists external_message_id text;

-- ★ ของจริงมี external_message_id อยู่แล้ว พร้อม UNIQUE (conversation_id, external_message_id)
--   จึงกันข้อความซ้ำได้อยู่แล้ว ไม่ต้องสร้าง index ใหม่
--
-- ★ ที่ถอดออกจากไฟล์นี้ เพราะอ้างถึงคอลัมน์ที่ไม่มีอยู่จริง (จะพังตอนรัน):
--     create unique index ... on inbox.message (channel_key, external_message_id)
--     create index ...        on inbox.conversation (channel_key, customer_ref)
--   inbox.message กับ inbox.conversation ไม่มีคอลัมน์ channel_key
--   ช่องทางอยู่ที่ inbox.inbox.channel (message -> conversation -> inbox)
--
-- ★ และไม่เพิ่ม inbox.conversation.customer_ref
--   ตัวตนลูกค้าฝั่งช่องทางมีที่อยู่แล้วคือ core.contact_identity(channel, external_id)
--   เพิ่มคอลัมน์ซ้ำ = มีแหล่งความจริงสองที่ แล้ววันหนึ่งมันจะไม่ตรงกัน
--   ผู้อ่าน outbox ได้ customer_ref ติดมากับเหตุการณ์อยู่แล้ว ไม่ต้องอ่านจากตารางห้อง

comment on column inbox.message.external_message_id is
  'mid ของ Meta / messageId ของ LINE — ของที่มาทีหลัง (fact, label, ผลวิเคราะห์) ชี้กลับมาที่นี่';

-- ---------------------------------------------------------------------
-- 2) outbox
--    ใช้ cursor ต่อ consumer ไม่ใช่ธง consumed_at ใบเดียว
--    เพราะจะมีหลายโมดูลอ่าน stream เดียวกัน คนละความเร็ว
--    (ธงใบเดียว = โมดูลแรกที่อ่าน จะกินเหตุการณ์ของโมดูลที่สอง)
-- ---------------------------------------------------------------------
create table if not exists inbox.event_outbox (
  id              bigserial primary key,
  at              timestamptz not null default clock_timestamp(),
  type            text not null,
  channel_key     text,
  conversation_id uuid,          -- inbox.conversation.id เป็น uuid
  message_id      uuid,          -- inbox.message.id เป็น uuid
  customer_ref    text,
  payload         jsonb not null default '{}'::jsonb
);
create index if not exists outbox_id_idx    on inbox.event_outbox (id);
create index if not exists outbox_type_idx  on inbox.event_outbox (type, id);

create table if not exists inbox.outbox_cursor (
  consumer     text primary key,
  last_id      bigint not null default 0,
  updated_at   timestamptz not null default now(),
  note         text
);

comment on table inbox.event_outbox is
  'เหตุการณ์ที่ inbox ประกาศออกมา โมดูลอื่น (CRM, content, รายงาน) อ่านผ่าน outbox_poll';

-- ประเภทเหตุการณ์ที่ประกาศตอนนี้:
--   customer.first_message  ลูกค้ารายนี้ทักเข้ามาครั้งแรกในช่องทางนี้
--   message.received        ลูกค้าส่งข้อความเข้ามา
--   reply.sent              ฝั่งเราตอบออกไป (แยก bot / คน ใน payload)
--   conversation.idle       เงียบไปเกินกำหนด (ยิงจาก cron)

create or replace function inbox.emit(
  p_type text, p_channel_key text, p_conversation_id uuid,
  p_message_id uuid, p_customer_ref text, p_payload jsonb default '{}')
returns bigint language sql as $$
  insert into inbox.event_outbox
    (type, channel_key, conversation_id, message_id, customer_ref, payload)
  values (p_type, p_channel_key, p_conversation_id, p_message_id, p_customer_ref,
          coalesce(p_payload,'{}'::jsonb))
  returning id
$$;

-- ---------------------------------------------------------------------
-- ประกาศเหตุการณ์จากข้อความ
-- อยู่ใน transaction เดียวกับ insert ข้อความโดยตั้งใจ — ข้อความเข้าแล้ว
-- เหตุการณ์ต้องออก ไม่งั้นโมดูลปลายทางจะมีข้อมูลไม่ครบแบบเงียบ ๆ
-- ถ้า normalize พัง ให้ตกไปที่เหตุการณ์แบบดิบ ดีกว่าไม่ประกาศอะไรเลย
-- ---------------------------------------------------------------------
create or replace function inbox.emit_from_message() returns trigger
language plpgsql as $$
declare n jsonb; v_ref text; v_first boolean;
begin
  begin
    n := inbox.stats_normalize(NEW);
    v_ref := n->>'customer_ref';

    if n->>'direction' = 'in' then
      if v_ref is not null then
        select not exists (
          select 1 from inbox.event_outbox
           where type = 'customer.first_message'
             and channel_key = n->>'channel_key' and customer_ref = v_ref)
          into v_first;
        if v_first then
          perform inbox.emit('customer.first_message', n->>'channel_key',
                   (n->>'conversation_id')::uuid, NEW.id, v_ref,
                   jsonb_build_object('project', n->>'project', 'at', n->>'created_at'));
        end if;
      end if;
      perform inbox.emit('message.received', n->>'channel_key',
               (n->>'conversation_id')::uuid, NEW.id, v_ref,
               jsonb_build_object('project', n->>'project', 'at', n->>'created_at'));
    else
      perform inbox.emit('reply.sent', n->>'channel_key',
               (n->>'conversation_id')::uuid, NEW.id, v_ref,
               jsonb_build_object('actor', n->>'actor', 'profile_id', n->>'profile_id',
                                  'at', n->>'created_at'));
    end if;
  exception when others then
    perform inbox.emit('message.raw', null, null, NEW.id, null,
                       jsonb_build_object('row', to_jsonb(NEW), 'error', SQLERRM));
  end;
  return NEW;
end $$;

drop trigger if exists trg_emit_from_message on inbox.message;
create trigger trg_emit_from_message
  after insert on inbox.message
  for each row execute function inbox.emit_from_message();

-- ---------------------------------------------------------------------
-- ห้องที่เงียบไป — ยิงจาก cron ไม่ใช่ trigger
-- ---------------------------------------------------------------------
create or replace function inbox.emit_idle_events(p_hours int default 24)
returns int language plpgsql as $$
declare v_n int := 0; r record;
begin
  for r in
    select w.conversation_id, w.channel_key, w.customer_ref, w.project, w.inbound_at
      from inbox.response_window w
     where w.closed_at is null
       and w.inbound_at < now() - make_interval(hours => p_hours)
       and not exists (
         select 1 from inbox.event_outbox e
          where e.type = 'conversation.idle'
            and e.conversation_id = w.conversation_id
            and e.at > w.inbound_at)
  loop
    perform inbox.emit('conversation.idle', r.channel_key, r.conversation_id, null,
             r.customer_ref,
             jsonb_build_object('project', r.project, 'since', r.inbound_at,
                                'hours', p_hours));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- ฝั่งผู้อ่าน
-- ---------------------------------------------------------------------
create or replace function inbox.outbox_poll(
  p_consumer text, p_limit int default 200, p_types text[] default null)
returns setof inbox.event_outbox language plpgsql as $$
declare v_last bigint;
begin
  insert into inbox.outbox_cursor (consumer) values (p_consumer)
  on conflict (consumer) do nothing;

  select last_id into v_last from inbox.outbox_cursor where consumer = p_consumer;

  return query
    select * from inbox.event_outbox
     where id > v_last
       and (p_types is null or type = any(p_types))
     order by id
     limit greatest(p_limit, 1);
end $$;

-- ยืนยันว่าอ่านถึงไหนแล้ว — เลื่อนหน้าเดียว ถอยหลังไม่ได้
create or replace function inbox.outbox_ack(p_consumer text, p_last_id bigint)
returns bigint language plpgsql as $$
declare v_new bigint;
begin
  insert into inbox.outbox_cursor (consumer, last_id) values (p_consumer, p_last_id)
  on conflict (consumer) do update
     set last_id = greatest(inbox.outbox_cursor.last_id, excluded.last_id),
         updated_at = now()
  returning last_id into v_new;
  return v_new;
end $$;

-- ---------------------------------------------------------------------
-- 3) นโยบายเก็บข้อมูล
--    แยกอายุของแต่ละชั้น ไม่ใช่ตัวเลขเดียวใช้ทั้งระบบ
--    ข้อความต้องอยู่นานกว่า payload ดิบ เพราะวงจรตัดสินใจซื้อคอนโด
--    6-18 เดือน ถ้าลบข้อความที่ 180 วันเท่า payload วันที่ทำ CRM
--    จะพบว่าบทสนทนาของลูกค้าที่ยังไม่ปิดหายไปแล้ว แกะย้อนหลังไม่ได้
-- ---------------------------------------------------------------------
create table if not exists inbox.retention_policy (
  scope       text primary key,
  keep_days   int not null,
  note        text,
  updated_at  timestamptz not null default now()
);

insert into inbox.retention_policy (scope, keep_days, note) values
  ('channel_event', 180,  'payload ดิบ มี PII เต็ม ๆ แกะเป็นข้อมูลสรุปแล้วลบได้'),
  ('message',      1095,  'ต้องยาวกว่าอายุ lead — ห้ามตั้งต่ำกว่า 540 วัน'),
  ('event_outbox',   30,  'ลบได้เมื่อ consumer ทุกตัวอ่านผ่านไปแล้ว')
on conflict (scope) do nothing;

-- ลบ outbox เฉพาะส่วนที่ผู้อ่านทุกตัวผ่านไปแล้ว
-- ถ้ามี consumer ที่ยังตามไม่ทัน จะไม่ลบ ต่อให้เก่าแค่ไหน
create or replace function inbox.purge_outbox()
returns int language plpgsql as $$
declare v_min bigint; v_days int; v_n int;
begin
  select keep_days into v_days from inbox.retention_policy where scope = 'event_outbox';
  select min(last_id) into v_min from inbox.outbox_cursor;
  if v_min is null then return 0; end if;

  delete from inbox.event_outbox
   where id <= v_min
     and at < now() - make_interval(days => coalesce(v_days, 30));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ลบข้อความตามนโยบาย — มีขั้นต่ำกันตั้งพลาด
create or replace function inbox.purge_messages()
returns int language plpgsql as $$
declare v_days int; v_n int;
begin
  select keep_days into v_days from inbox.retention_policy where scope = 'message';
  if v_days is null or v_days < 540 then
    raise exception 'inbox: อายุการเก็บข้อความต้องไม่ต่ำกว่า 540 วัน (ตั้งไว้ %)', v_days;
  end if;
  delete from inbox.message where created_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ให้ purge ของ payload ดิบอ่านจากตารางนโยบายด้วย จะได้แก้ที่เดียว
-- ★ ตัวนี้ชื่อและลายเซ็นเดียวกับใน 0005 (p_days int) จึง "ทับ" ของเดิมโดยตั้งใจ
--   ลำดับไฟล์จึงสลับไม่ได้ — ลง 0006 ก่อน 0005 แล้วจะได้ตัวที่ไม่อ่านนโยบาย
create or replace function inbox.purge_channel_events(p_days int default null)
returns int language plpgsql as $$
declare v_days int; v_n int;
begin
  v_days := coalesce(p_days,
    (select keep_days from inbox.retention_policy where scope = 'channel_event'), 180);
  delete from inbox.channel_event
   where received_at < now() - make_interval(days => v_days)
     and extracted;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- cron (เวลาไทย = UTC+7)
-- select cron.schedule('purge_outbox','30 18 * * *', $$select inbox.purge_outbox()$$);
-- select cron.schedule('emit_idle','0 * * * *',      $$select inbox.emit_idle_events(24)$$);
