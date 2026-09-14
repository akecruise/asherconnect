-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 — ของที่เป็นเรื่องเฉพาะ LINE
--
--   ทีมขาย        sales_staff · sales_staff_identity · human_reply_events
--   คำสั่งในกลุ่ม   ตอบแล้ว · หยุด · บอท · ลงทะเบียน · ฉันใคร · สถานะ · ไอดีกลุ่ม
--   เพิ่มเพื่อน     ส่งข้อความต้อนรับ + แจ้งทีม
--   บล็อก         core.contact.blocked
--   [AD:xxx]      ติด ad_id ให้ทั้งบทสนทนา
--   reply token   เก็บไว้ให้ชั้นส่งของเลือกใช้ ถ้ายังไม่หมดอายุ
--
-- ★ ไม่มีค่าเวลา/นาทีตัวไหน hardcode ในไฟล์นี้ — อ่านจาก bot_config ต่อ inbox ทั้งหมด
--   ตามที่ PLAN สั่ง เพราะ LINE กับ FB จะถูกรวมเป็นชุดเดียวทีหลัง
--   วันนั้นจะเปลี่ยนแค่ข้อมูล ไม่ใช่แก้โค้ด
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) ทีมขาย
--
-- ไม่มีตาราง user_access ในฐานนี้ (ตรวจแล้ว) ตัวที่ทำหน้าที่นั้นคือ core.profile
-- สมาชิกทีมที่มีบัญชีในระบบอยู่แล้วจึงผูกกับ core."user" ผ่าน user_id
-- ส่วนคนที่ตอบจาก chat.line.biz อย่างเดียวและไม่มีบัญชี ปล่อย user_id ว่างไว้ได้
-- ─────────────────────────────────────────────────────────────────��─────────
create table if not exists inbox.sales_staff (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  user_id    uuid references core."user"(id) on delete set null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists sales_staff_user_key on inbox.sales_staff(user_id) where user_id is not null;

create table if not exists inbox.sales_staff_identity (
  channel     text not null,
  external_id text not null,
  staff_id    uuid not null references inbox.sales_staff(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (channel, external_id)
);

/**
 * ใครตอบลูกค้าเมื่อไหร่ และรู้ได้ยังไง
 *
 * source บอกว่าสัญญาณมาจากไหน ซึ่งสำคัญกว่าที่คิด เพราะความน่าเชื่อไม่เท่ากัน
 *   workspace  เซลส์กดส่งจากหน้าจอเรา          — แน่นอนที่สุด
 *   echo       Meta ส่งสำเนาคำตอบของเพจกลับมา  — แน่นอน แต่ไม่รู้ว่าใคร
 *   group_cmd  ทีมพิมพ์ "ตอบแล้ว" ในกลุ่ม        — เชื่อคน
 *   api        Marketing OS ยิงมาบอก             — เชื่อระบบอื่น
 */
create table if not exists inbox.human_reply_events (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references inbox.conversation(id) on delete cascade,
  staff_id        uuid references inbox.sales_staff(id) on delete set null,
  source          text not null check (source in ('workspace','echo','group_cmd','api')),
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists human_reply_events_conversation_idx
  on inbox.human_reply_events(conversation_id, created_at desc);

alter table inbox.sales_staff          enable row level security;
alter table inbox.sales_staff_identity enable row level security;
alter table inbox.human_reply_events   enable row level security;
revoke all on inbox.sales_staff, inbox.sales_staff_identity, inbox.human_reply_events
  from public, anon, authenticated;
grant select, insert, update, delete
  on inbox.sales_staff, inbox.sales_staff_identity, inbox.human_reply_events to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) ลูกค้าที่บล็อกบัญชีเราไปแล้ว
--
-- ยิง push หา LINE ที่บล็อกเราแล้วจะได้ 403 ทุกครั้ง ไม่ว่ากี่รอบ
-- รู้ไว้ก่อนดีกว่าเสียโควตาและเสียเวลาไล่ว่าทำไมส่งไม่ออก
-- ───────────────────────────────────────────────────────────────────────────
alter table core.contact
  add column if not exists blocked    boolean not null default false,
  add column if not exists blocked_at timestamptz;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) reply token
--
-- LINE ให้ token ตอบกลับที่ถูกกว่าและเร็วกว่า push แต่หมดอายุไวมาก
-- เก็บไว้ที่บทสนทนาพร้อมเวลา แล้วให้ชั้นส่งของตัดสินเองว่าจะใช้หรือจะ push
-- (เพดานเวลาอยู่ใน bot_config: delay.reply_token_max_sec)
-- ───────────────────────────────────────────────────────────────────────────
alter table inbox.conversation
  add column if not exists last_reply_token    text,
  add column if not exists last_reply_token_at timestamptz;


-- ───────────────────────────────────────────────────────────────────────────
-- 4) "คนตอบแล้ว" — ทางเดียวที่ทุกสัญญาณมารวมกัน
--
-- PLAN บอกว่าสัญญาณหลักคือเซลส์กดส่งจากหน้าจอเรา ส่วนคำสั่งกลุ่มกับ endpoint
-- เป็นทางสำรองช่วงเปลี่ยนผ่าน — ทั้งสามทางจึงต้องจบที่ฟังก์ชันนี้ฟังก์ชันเดียว
-- ไม่งั้นวันหนึ่งจะมีทางใดทางหนึ่งที่ลืมยกเลิกงานที่บอทจ่อจะส่ง
-- ───────────────────────────────────────────────────────────────────────────
create or replace function connect_private.mark_human_reply(
  p_conversation uuid, p_staff uuid, p_source text, p_now timestamptz default now(), p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_cancelled int := 0;
begin
  update inbox.conversation set last_human_reply_at = p_now where id = p_conversation;

  with x as (
    update connect_private.job set status = 'skipped', skip_reason = 'human_replied', finished_at = p_now
     where conversation_id = p_conversation and kind in ('generate','send') and status = 'pending'
     returning 1)
  select count(*) into v_cancelled from x;

  update connect_private.case_state set waiting_since = null where conversation_id = p_conversation;

  insert into inbox.human_reply_events(conversation_id, staff_id, source, note, created_at)
  values (p_conversation, p_staff, p_source, p_note, p_now);

  return jsonb_build_object('ok', true, 'cancelled_jobs', v_cancelled);
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 5) คำสั่งในกลุ่ม LINE
--
-- ทีมสั่งงานบอทจากกลุ่มแจ้งเตือนได้ เพราะ LINE ไม่มี echo เหมือน Messenger
-- ฝั่งเราจึงไม่มีทางรู้เองว่าใครตอบไปแล้ว ต้องให้คนบอก
--
-- <รหัส> คือหกตัวท้ายของ LINE userId ซึ่งเป็นสิ่งที่ข้อความแจ้งพิมพ์ให้ทีมเห็น
-- คืนค่าเป็นข้อความที่จะตอบกลับเข้ากลุ่ม — ตัวฟังก์ชันไม่ส่งอะไรเอง
-- การส่งเป็นหน้าที่ของคิวขาออกทางเดียวเหมือนทุกอย่างในระบบนี้
-- ───────────────────────────────────────────────────────────────────────────
create or replace function connect_private.group_command(
  p_inbox uuid, p_group_id text, p_user_id text, p_text text, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_raw text := btrim(coalesce(p_text, ''));
  v_cmd text; v_arg text; v_rest text;
  v_conv uuid; v_contact uuid; v_external text; v_staff uuid; v_name text;
  v_hold int; v_reply text;
begin
  if v_raw = '' then return jsonb_build_object('handled', false); end if;
  v_cmd  := split_part(v_raw, ' ', 1);
  v_arg  := split_part(v_raw, ' ', 2);
  v_rest := btrim(substr(v_raw, length(v_cmd) + length(v_arg) + 2));

  -- ── ไอดีกลุ่ม: ไว้เอาไปใส่ LINE_NOTIFY_GROUP_ID
  if lower(v_cmd) in ('ไอดีกลุ่ม', 'groupid') then
    return jsonb_build_object('handled', true, 'reply', 'groupId: ' || coalesce(p_group_id, '(ไม่ทราบ)'));
  end if;

  -- ── สถานะ: บอทเปิดอยู่ไหม ตารางเวลาเป็นยังไง มีงานค้างไหม
  if lower(v_cmd) in ('สถานะ', 'status') then
    select string_agg(s.start_hour || '-' || s.end_hour ||
             case when s.mode = 'wait_human' then '(รอคน ' || s.wait_min || 'น.)' else '(ตอบเลย)' end, ' · '
             order by s.start_hour)
      into v_reply from inbox.bot_schedule s where s.inbox_id = p_inbox and s.is_active;
    return jsonb_build_object('handled', true, 'reply', concat_ws(chr(10),
      'สถานะบอท (' || to_char(p_now at time zone 'Asia/Bangkok', 'HH24:MI') || ' น.)',
      'คิดคำตอบ: ' || case when inbox.cfg_bool(p_inbox,'bot.generate_enabled',false) then 'เปิด' else 'ปิด' end
        || ' · ถอดหมวด: ' || case when inbox.cfg_bool(p_inbox,'bot.classify_enabled',false) then 'เปิด' else 'ปิด' end,
      'ตารางตอบ: ' || coalesce(v_reply, '(ไม่ได้ตั้ง)'),
      'คนตอบแล้วบอทเงียบ: ' || inbox.cfg_int(p_inbox,'reply.human_hold_min',30) || ' นาที',
      'งานค้าง: ' || (select count(*) from connect_private.job where inbox_id = p_inbox and status = 'pending') || ' ชิ้น',
      'คำสั่ง: ตอบแล้ว <รหัส> [ชื่อ] · หยุด <รหัส> · บอท <รหัส> · ลงทะเบียน <ชื่อ> · ฉันใคร · สถานะ · ไอดีกลุ่ม'));
  end if;

  -- ── ลงทะเบียน <ชื่อ>: ผูก LINE ของคนในทีมกับชื่อ เพื่อให้รู้ว่าใครเป็นคนตอบ
  if lower(v_cmd) = 'ลงทะเบียน' then
    v_name := btrim(v_arg || ' ' || v_rest);
    if v_name = '' then
      return jsonb_build_object('handled', true, 'reply', 'พิมพ์ว่า "ลงทะเบียน <ชื่อของคุณ>" นะคะ');
    end if;
    if p_user_id is null then
      -- LINE ไม่ส่ง userId มาให้เสมอในกลุ่ม (ขึ้นกับการตั้งค่าความเป็นส่วนตัวของ OA)
      return jsonb_build_object('handled', true, 'reply',
        'ยังผูกให้ไม่ได้ค่ะ LINE ไม่ได้ส่งรหัสผู้ใช้มากับข้อความนี้');
    end if;
    select staff_id into v_staff from inbox.sales_staff_identity where channel='line' and external_id = p_user_id;
    if v_staff is null then
      insert into inbox.sales_staff(name) values (v_name) returning id into v_staff;
      insert into inbox.sales_staff_identity(channel, external_id, staff_id) values ('line', p_user_id, v_staff);
    else
      update inbox.sales_staff set name = v_name where id = v_staff;
    end if;
    return jsonb_build_object('handled', true, 'reply', 'ลงทะเบียนให้แล้วค่ะ คุณ ' || v_name);
  end if;

  -- ── ฉันใคร: ตรวจว่าระบบรู้จักเราหรือยัง
  if lower(v_cmd) in ('ฉันใคร', 'whoami') then
    select st.name into v_name from inbox.sales_staff_identity si
      join inbox.sales_staff st on st.id = si.staff_id
     where si.channel='line' and si.external_id = p_user_id;
    return jsonb_build_object('handled', true, 'reply', coalesce(
      'คุณคือ ' || v_name, 'ยังไม่ได้ลงทะเบียนค่ะ พิมพ์ "ลงทะเบียน <ชื่อของคุณ>" ได้เลย'));
  end if;

  -- ── คำสั่งที่ต้องระบุเคส
  if lower(v_cmd) not in ('ตอบแล้ว','รับเคส','หยุด','บอท') then
    return jsonb_build_object('handled', false);
  end if;
  if coalesce(v_arg,'') = '' then
    return jsonb_build_object('handled', true, 'reply', 'ต้องบอกรหัสเคสด้วยค่ะ เช่น "' || v_cmd || ' a1b2c3"');
  end if;

  -- หกตัวท้ายของ LINE userId — ตรงกับที่ข้อความแจ้งพิมพ์ให้ทีมเห็น
  select c.id, ci.contact_id, ci.external_id into v_conv, v_contact, v_external
    from core.contact_identity ci
    join inbox.conversation c on c.contact_id = ci.contact_id and c.inbox_id = p_inbox
   where ci.channel = 'line' and ci.account_key = p_inbox::text and ci.external_id ilike '%' || v_arg
   order by c.last_message_at desc nulls last
   limit 1;

  if v_conv is null then
    return jsonb_build_object('handled', true, 'reply', 'ไม่พบเคส ' || v_arg || ' ค่ะ');
  end if;

  if lower(v_cmd) in ('ตอบแล้ว','รับเคส') then
    -- ชื่อที่พิมพ์ต่อท้ายใช้บอกว่าใครตอบ ถ้าไม่พิมพ์ก็ดูจาก LINE ของคนสั่ง
    select staff_id into v_staff from inbox.sales_staff_identity
     where channel='line' and external_id = p_user_id;
    if v_staff is null and btrim(v_rest) <> '' then
      insert into inbox.sales_staff(name) values (btrim(v_rest)) returning id into v_staff;
      if p_user_id is not null then
        insert into inbox.sales_staff_identity(channel, external_id, staff_id)
        values ('line', p_user_id, v_staff) on conflict do nothing;
      end if;
    end if;
    perform connect_private.mark_human_reply(v_conv, v_staff, 'group_cmd', p_now,
              nullif(btrim(v_rest), ''));
    v_hold := inbox.cfg_int(p_inbox, 'reply.human_hold_min', 30);
    return jsonb_build_object('handled', true, 'conversation_id', v_conv,
      'reply', 'รับทราบค่ะ บอทจะเงียบเคส ' || v_arg || ' อีก ' || v_hold || ' นาที');
  end if;

  if lower(v_cmd) = 'หยุด' then
    update inbox.conversation set mode = 'human' where id = v_conv;
    return jsonb_build_object('handled', true, 'conversation_id', v_conv,
      'reply', 'ปิดบอทเคส ' || v_arg || ' แล้วค่ะ (พิมพ์ "บอท ' || v_arg || '" เพื่อเปิดคืน)');
  end if;

  update inbox.conversation set mode = 'bot' where id = v_conv;
  return jsonb_build_object('handled', true, 'conversation_id', v_conv,
    'reply', 'เปิดบอทเคส ' || v_arg || ' แล้วค่ะ');
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 6) [AD:xxx] — ข้อความ prefill จากลิงก์โฆษณา
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.strip_ad_prefix(p_text text, p_pattern text default '^\[AD:([a-zA-Z0-9_-]+)\]\s*')
returns jsonb
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare v_ad text; v_rest text;
begin
  if p_text is null then return jsonb_build_object('text', null, 'ad_id', null); end if;
  v_ad := substring(p_text from p_pattern);
  if v_ad is null then return jsonb_build_object('text', p_text, 'ad_id', null); end if;
  v_rest := btrim(regexp_replace(p_text, p_pattern, ''));
  -- ลูกค้ากดลิงก์แล้วส่งมาแต่ prefix เปล่า ๆ ได้ — ต้องมีข้อความอะไรสักอย่างให้บอทอ่าน
  return jsonb_build_object('text', coalesce(nullif(v_rest, ''), 'สนใจโครงการค่ะ'), 'ad_id', v_ad);
end $$;

commit;
