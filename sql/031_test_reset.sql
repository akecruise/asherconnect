-- =====================================================================
-- ASHER Connect — คำสั่ง "test" รีเซ็ตแชททดสอบ
--
-- ปัญหาที่แก้: แชทที่ถูกตั้ง mode='human' บอทจะเงียบถาวร ไม่มีกลไกสลับกลับ
-- ทีมต้องทดสอบบอทบ่อย จึงต้องมีวิธีล้างสถานะให้กลับไปเริ่มใหม่ได้ทันที
--
-- ★ allowlist ของบัญชีทดสอบอยู่ใน env (TEST_USER_IDS) ไม่ได้อยู่ในฐาน
--   ฐานไม่ต้องรู้ว่าใครเป็นบัญชีทดสอบ รู้แค่ว่าถูกสั่งให้รีเซ็ตแชทไหน
--   ด่านว่าใครสั่งได้อยู่ที่ชั้นเว็บ ที่นี่กันแค่ service_role
--
-- ★ is_test ติดถาวร ไม่มีคำสั่งปลด — แชทที่เคยใช้ทดสอบจะไม่ถูกนับเป็นงานจริง
--   ตลอดไป ปลดได้ก็เท่ากับเปิดช่องให้ข้อมูลทดสอบไหลเข้าสถิติย้อนหลัง
-- =====================================================================

-- ── ธงบอกว่าแชทนี้ใช้ทดสอบ ──────────────────────────────────────────
alter table inbox.conversation
  add column if not exists is_test boolean not null default false;

comment on column inbox.conversation.is_test is
  'แชททดสอบ — ไม่นับใน SLA/สถิติ/คะแนนผู้ตอบ/รายงาน · ติดถาวร ไม่มีคำสั่งปลด';

-- ดัชนีบางส่วน: แถวทดสอบมีน้อยมากเมื่อเทียบกับของจริง
-- ทำ index เต็มจะเปลืองโดยไม่ได้อะไร เพราะคิวรีที่ใช้จริงคือ "ไม่ใช่ test"
create index if not exists conversation_is_test_idx
  on inbox.conversation (inbox_id, last_message_at desc) where is_test;

-- ---------------------------------------------------------------------
-- รีเซ็ตแชททดสอบ
--
-- p_data = { inbox_id, channel, external_id, display_name? }
--
-- ★ idempotent — เรียกซ้ำได้ ผลเหมือนเดิมทุกครั้ง ไม่พัง
-- ★ ไม่ลบข้อความเดิมสักข้อความ ประวัติยังอยู่ครบ
-- ★ ยังไม่มีแถว conversation → สร้างให้ (upsert) ไม่ใช่ no-op
--   เหตุผล: ถ้าไม่สร้าง บัญชีทดสอบที่พิมพ์ "test" เป็นข้อความแรกจะยังไม่มีแถว
--   ให้ติดธง พอส่งข้อความจริงถัดไปก็เข้าไปปนในสถิติทันที ซึ่งขัดจุดประสงค์ทั้งหมด
-- ---------------------------------------------------------------------
create or replace function connect_private.reset_test_conversation(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inbox     inbox.inbox;
  v_contact   uuid;
  v_conv      uuid;
  v_prev_mode text;
  v_created   boolean := false;
  v_cancelled int := 0;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'service_only' using errcode = '42501';
  end if;

  select * into v_inbox from inbox.inbox
   where id = (p_data->>'inbox_id')::uuid and is_active;
  if not found then raise exception 'channel_not_configured'; end if;

  if coalesce(p_data->>'external_id', '') = '' then
    raise exception 'invalid_event';
  end if;

  -- ล็อกด้วยกุญแจเดียวกับ receive() เพื่อไม่ให้ชนกับข้อความที่กำลังเข้ามาพร้อมกัน
  perform pg_advisory_xact_lock(
    hashtextextended(v_inbox.id::text || ':' || (p_data->>'external_id'), 0));

  v_contact := core.resolve_identity(
    v_inbox.channel, p_data->>'external_id', v_inbox.id::text,
    nullif(p_data->>'display_name', ''), v_inbox.project_id);

  select id, mode into v_conv, v_prev_mode
    from inbox.conversation
   where inbox_id = v_inbox.id and contact_id = v_contact
   order by last_message_at desc nulls last, created_at desc
   limit 1;

  if v_conv is null then
    insert into inbox.conversation (inbox_id, contact_id, mode, is_test, last_message_at)
    values (v_inbox.id, v_contact, 'bot', true, now())
    returning id into v_conv;
    v_created := true;
  else
    -- ★ ตั้งแค่ mode — bot_active ปล่อยให้ trigger conversation_sync_mode จัดการ
    --   (BEFORE INSERT OR UPDATE · mode ชนะเมื่อแก้มาพร้อมกัน) มีความจริงเดียว
    update inbox.conversation
       set mode                = 'bot',
           is_test             = true,
           offtopic_count      = 0,
           offtopic_date       = null,
           last_human_reply_at = null,
           last_bot_reply_at   = null,
           last_notified_at    = null,
           sla_due_at          = null,
           unread_count        = 0
     where id = v_conv;
  end if;

  -- งานค้างของแชทนี้ต้องไม่วิ่งต่อหลังรีเซ็ต ไม่งั้นบอทจะตอบข้อความรอบก่อน
  update connect_private.job
     set status = 'skipped', skip_reason = 'test_reset', finished_at = now()
   where conversation_id = v_conv and status = 'pending';
  get diagnostics v_cancelled = row_count;

  -- ★ ไม่ลบแถว case_state — lead_id กับ first_human_response_at เป็นประวัติจริง
  --   ล้างเฉพาะสามช่องที่เป็น "สิ่งที่ต้องทำต่อ" แล้ว bump version
  update connect_private.case_state
     set follow_up_at   = null,
         appointment_at = null,
         waiting_since  = null,
         version        = version + 1
   where conversation_id = v_conv;

  insert into connect_private.audit (action, conversation_id, detail)
  values ('test_reset', v_conv, jsonb_build_object(
    'channel',        v_inbox.channel,
    'user_id',        p_data->>'external_id',
    'previous_mode',  v_prev_mode,
    'cancelled_jobs', v_cancelled,
    'created',        v_created));

  return jsonb_build_object(
    'conversation_id', v_conv,
    'created', v_created,
    'previous_mode', v_prev_mode,
    'cancelled_jobs', v_cancelled);
end $$;

revoke all on function connect_private.reset_test_conversation(jsonb) from public;
