-- =====================================================================
-- selftest ของ 033 — ตรวจว่ากิ่งที่กู้กลับมาทำงานจริง ไม่ใช่แค่มีอยู่ในนิยาม
-- =====================================================================
-- ★ ไฟล์นี้ "เขียนลงฐาน" แต่ห่อไว้ใน begin … rollback ทั้งก้อน
--   จบแล้วไม่มีแถวใดเหลือ — ถึงอย่างนั้นก็ยังมีด่านกันรันพลาด
--
-- วิธีรัน (ต้องตั้ง ALLOW_DB_TESTS=1 เอง ไม่มีค่าตั้งต้น):
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f 033_receive_event_selftest.sql
--
-- ★ ทุก external_id / group_id / event_id ขึ้นต้นด้วย __selftest__
--   และล้างทั้งตอนเริ่มและตอนจบ (นอกเหนือจาก rollback) เพื่อให้ปลอดภัย
--   แม้จะมีใครเผลอเปลี่ยน rollback เป็น commit
-- =====================================================================

do $guard$
begin
  if current_setting('asher.allow_db_tests', true) is distinct from '1' then
    raise exception 'ข้าม selftest — ต้องตั้ง ALLOW_DB_TESTS=1 และ PGOPTIONS=''-c asher.allow_db_tests=1'' ก่อน';
  end if;
end $guard$;

begin;

-- ── ล้างของเก่าตอนเริ่ม ─────────────────────────────────────────────
delete from connect_private.inbound_event where event_id like '\_\_selftest\_\_%';
delete from connect_private.job where target like '\_\_selftest\_\_%' or target like 'C\_\_selftest\_\_%';
delete from core.contact_identity where external_id like '%\_\_selftest\_\_%';

do $test$
declare
  v_inbox uuid;
  v_conv  uuid;
  r jsonb;
  v_text text; v_ad text; v_token text; v_bot text; v_job int;
  v_fail int := 0;
  procedure_note text;
begin
  select id into v_inbox from inbox.inbox where channel = 'line' and is_active
   order by created_at limit 1;
  if v_inbox is null then raise exception 'ไม่มี inbox line ที่ active ให้ทดสอบ'; end if;
  raise notice 'ใช้ inbox: %', v_inbox;

  -- ══ 1) group_command — คำสั่งในกลุ่ม LINE ══════════════════════════
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_inbox, 'event_id', '__selftest__gc1', 'event_type', 'group_command',
         'group_id', 'C__selftest__group', 'external_id', 'U__selftest__staff',
         'source_type', 'group', 'content_type', 'text', 'text', 'groupid'), now());
  select count(*) into v_job from connect_private.job
   where target = 'C__selftest__group' and channel = 'line_group' and kind = 'send';
  if coalesce((r->>'handled')::boolean,false)
     and r->>'reply' = 'groupId: C__selftest__group' and v_job = 1 then
    raise notice '1) group_command            ผ่าน  (ตอบ: % · เข้าคิวส่งกลับกลุ่ม % งาน)', r->>'reply', v_job;
  else
    v_fail := v_fail + 1;
    raise warning '1) group_command            ★ ตก  r=% job=%', r, v_job;
  end if;

  -- ══ 2) reply_token + ad attribution + ตัด prefix โฆษณา ═════════════
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_inbox, 'event_id', '__selftest__msg1', 'event_type', 'message',
         'external_id', 'U__selftest__cust', 'display_name', 'ลูกค้า selftest',
         'content_type', 'text', 'text', '[AD:ad_selftest_1] สนใจครับ 0812345678',
         'reply_token', '__selftest__rtoken', 'occurred_at', now()), now());
  v_conv := (r->>'id')::uuid;
  select c.last_reply_token, c.ad_id into v_token, v_ad from inbox.conversation c where c.id = v_conv;
  select m.content into v_text from inbox.message m where m.id = (r->>'message_id')::uuid;

  if v_token = '__selftest__rtoken' then
    raise notice '2) เก็บ reply_token          ผ่าน  (last_reply_token=%)', v_token;
  else
    v_fail := v_fail + 1; raise warning '2) เก็บ reply_token          ★ ตก  ได้ %', coalesce(v_token,'(ว่าง)');
  end if;

  if v_ad = 'ad_selftest_1' then
    raise notice '3) ad attribution (LINE)     ผ่าน  (conversation.ad_id=%)', v_ad;
  else
    v_fail := v_fail + 1; raise warning '3) ad attribution (LINE)     ★ ตก  ได้ %', coalesce(v_ad,'(ว่าง)');
  end if;

  if v_text = 'สนใจครับ 0812345678' then
    raise notice '4) ตัด prefix [AD:…] ออก      ผ่าน  (เก็บข้อความว่า "%")', v_text;
  else
    v_fail := v_fail + 1; raise warning '4) ตัด prefix [AD:…] ออก      ★ ตก  ได้ "%"', v_text;
  end if;

  if inbox.extract_phone(v_text) = '0812345678' then
    raise notice '5) จับเบอร์โทรจากข้อความจริง    ผ่าน  (%)', inbox.extract_phone(v_text);
  else
    v_fail := v_fail + 1; raise warning '5) จับเบอร์โทร               ★ ตก  ได้ %', coalesce(inbox.extract_phone(v_text),'(ว่าง)');
  end if;

  -- ══ 3) ข้อความต้อนรับตอนลูกค้าเพิ่มเพื่อน ═══════════════════════════
  insert into inbox.bot_config(inbox_id, key, value) values
    (v_inbox, 'reply.reply_to_follow', to_jsonb(true)),
    (v_inbox, 'line.welcome_on_follow', to_jsonb('ยินดีต้อนรับค่ะ (selftest)'::text))
  on conflict (inbox_id, key) do update set value = excluded.value;

  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_inbox, 'event_id', '__selftest__follow1', 'event_type', 'follow',
         'external_id', 'U__selftest__follower', 'content_type', 'follow',
         'text', '[ลูกค้าเพิ่มเพื่อน]', 'occurred_at', now()), now());
  select m.content into v_bot from inbox.message m
   where m.conversation_id = (r->>'id')::uuid and m.sender_type = 'bot'
   order by m.created_at desc limit 1;
  if v_bot = 'ยินดีต้อนรับค่ะ (selftest)' then
    raise notice '6) ข้อความต้อนรับตอน follow   ผ่าน  (บอทตอบ "%")', v_bot;
  else
    v_fail := v_fail + 1; raise warning '6) ข้อความต้อนรับตอน follow   ★ ตก  ได้ %', coalesce(v_bot,'(ไม่มีข้อความบอท)');
  end if;

  if v_fail = 0 then raise notice '── ผ่านทั้ง 6 ข้อ ──';
  else raise exception 'selftest ตก % ข้อ', v_fail; end if;
end $test$;

-- ── ล้างตอนจบ (rollback ก็ล้างให้แล้ว แต่ทำไว้ให้ครบตามกติกา) ────────
delete from connect_private.inbound_event where event_id like '\_\_selftest\_\_%';
delete from connect_private.job where target like '%\_\_selftest\_\_%';
delete from core.contact_identity where external_id like '%\_\_selftest\_\_%';

rollback;
