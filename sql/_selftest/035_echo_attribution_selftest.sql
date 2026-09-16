-- =====================================================================
-- selftest ของ 035 — echo attribution ทำงานจริงไหม (ไม่ใช่แค่มีอยู่ในนิยาม)
-- =====================================================================
-- ★ ไฟล์นี้เขียนลงฐาน แต่ห่อ begin … rollback ทั้งก้อน จบแล้วไม่เหลือแถวใด
--   ถึงอย่างนั้นก็ยังมีด่านกันรันพลาด และล้าง __selftest__ ทั้งตอนเริ่มและตอนจบ
--
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f 035_echo_attribution_selftest.sql
--
-- ครอบ 6 เคสเดิมของ 033 (ห้ามพัง) + 5 เคสใหม่ของ 035
-- =====================================================================

do $guard$
begin
  if current_setting('asher.allow_db_tests', true) is distinct from '1' then
    raise exception 'ข้าม selftest — ต้องตั้ง ALLOW_DB_TESTS=1 และ PGOPTIONS=''-c asher.allow_db_tests=1'' ก่อน';
  end if;
end $guard$;

begin;

delete from connect_private.inbound_event where event_id like '%\_\_selftest\_\_%';
delete from connect_private.job where coalesce(target,'') like '%\_\_selftest\_\_%';
delete from core.contact_identity where external_id like '%\_\_selftest\_\_%';

do $test$
declare
  v_line   uuid;
  v_msgr   uuid;
  v_conv   uuid;
  v_botmsg uuid;
  v_before int;
  v_after  int;
  r jsonb;
  v_txt text; v_ad text; v_token text; v_bot text; v_job int;
  v_src text; v_link boolean; v_who text; v_note text;
  v_hr timestamptz; v_br timestamptz;
  v_fail int := 0;
  BOT_APP  text := '946246731840651';
  PAGE_APP text := '263902037430900';
begin
  select id into v_line from inbox.inbox where channel = 'line' and is_active order by created_at limit 1;
  select id into v_msgr from inbox.inbox where channel = 'messenger' and is_active order by created_at limit 1;
  if v_line is null or v_msgr is null then raise exception 'ต้องมี inbox ทั้ง line และ messenger ที่ active'; end if;

  -- ════════ 6 เคสเดิมของ 033 — ห้ามพัง ════════
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_line, 'event_id', '__selftest__gc1', 'event_type', 'group_command',
         'group_id', 'C__selftest__group', 'external_id', 'U__selftest__staff',
         'source_type', 'group', 'content_type', 'text', 'text', 'groupid'), now());
  select count(*) into v_job from connect_private.job
   where target = 'C__selftest__group' and channel = 'line_group' and kind = 'send';
  if coalesce((r->>'handled')::boolean,false) and r->>'reply' = 'groupId: C__selftest__group' and v_job = 1
    then raise notice ' 1) group_command (033)        ผ่าน';
    else v_fail := v_fail + 1; raise warning ' 1) group_command (033)        ★ ตก  r=% job=%', r, v_job; end if;

  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_line, 'event_id', '__selftest__msg1', 'event_type', 'message',
         'external_id', 'U__selftest__cust', 'display_name', 'ลูกค้า selftest',
         'content_type', 'text', 'text', '[AD:ad_selftest_1] สนใจครับ 0812345678',
         'reply_token', '__selftest__rtoken', 'occurred_at', now()), now());
  select c.last_reply_token, c.ad_id into v_token, v_ad from inbox.conversation c where c.id = (r->>'id')::uuid;
  select m.content into v_txt from inbox.message m where m.id = (r->>'message_id')::uuid;

  if v_token = '__selftest__rtoken'
    then raise notice ' 2) เก็บ reply_token (033)     ผ่าน';
    else v_fail := v_fail + 1; raise warning ' 2) เก็บ reply_token (033)     ★ ตก  ได้ %', coalesce(v_token,'(ว่าง)'); end if;

  if v_ad = 'ad_selftest_1'
    then raise notice ' 3) ad attribution (033)       ผ่าน';
    else v_fail := v_fail + 1; raise warning ' 3) ad attribution (033)       ★ ตก  ได้ %', coalesce(v_ad,'(ว่าง)'); end if;

  if v_txt = 'สนใจครับ 0812345678'
    then raise notice ' 4) ตัด prefix [AD:…] (033)     ผ่าน';
    else v_fail := v_fail + 1; raise warning ' 4) ตัด prefix [AD:…] (033)     ★ ตก  ได้ "%"', v_txt; end if;

  if inbox.extract_phone(v_txt) = '0812345678'
    then raise notice ' 5) จับเบอร์โทร (033)          ผ่าน';
    else v_fail := v_fail + 1; raise warning ' 5) จับเบอร์โทร (033)          ★ ตก'; end if;

  insert into inbox.bot_config(inbox_id, key, value) values
    (v_line, 'reply.reply_to_follow', to_jsonb(true)),
    (v_line, 'line.welcome_on_follow', to_jsonb('ยินดีต้อนรับค่ะ (selftest)'::text))
  on conflict (inbox_id, key) do update set value = excluded.value;

  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_line, 'event_id', '__selftest__follow1', 'event_type', 'follow',
         'external_id', 'U__selftest__follower', 'content_type', 'follow',
         'text', '[ลูกค้าเพิ่มเพื่อน]', 'occurred_at', now()), now());
  select m.content into v_bot from inbox.message m
   where m.conversation_id = (r->>'id')::uuid and m.sender_type = 'bot'
   order by m.created_at desc limit 1;
  if v_bot = 'ยินดีต้อนรับค่ะ (selftest)'
    then raise notice ' 6) ข้อความต้อนรับ follow (033) ผ่าน';
    else v_fail := v_fail + 1; raise warning ' 6) ข้อความต้อนรับ follow (033) ★ ตก  ได้ %', coalesce(v_bot,'(ไม่มี)'); end if;

  -- ════════ เตรียมบทสนทนา messenger สำหรับเคส echo ════════
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_msgr, 'event_id', '__selftest__mcust1', 'event_type', 'message',
         'external_id', 'U__selftest__mcust', 'display_name', 'ลูกค้า messenger selftest',
         'content_type', 'text', 'text', 'สนใจห้อง 1 นอนครับ', 'occurred_at', now()), now());
  v_conv := (r->>'id')::uuid;

  -- ════════ 7) echo ของแอปเราเอง · mid ตรงกับคิวขาออก → ผูกแถวเดิม ════════
  insert into inbox.message(conversation_id, sender_type, content, content_type, event_type)
  values (v_conv, 'bot', 'ห้อง 1 นอน เริ่ม 2.39 ลบ. ค่ะ', 'text', 'message')
  returning id into v_botmsg;
  update connect_private.delivery set provider_id = 'm___selftest__mid_bot1' where message_id = v_botmsg;

  select count(*) into v_before from inbox.message where conversation_id = v_conv;
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_msgr, 'event_id', 'm___selftest__mid_bot1', 'event_type', 'echo',
         'external_id', 'U__selftest__mcust', 'app_id', BOT_APP,
         'content_type', 'text', 'text', 'ห้อง 1 นอน เริ่ม 2.39 ลบ. ค่ะ', 'occurred_at', now()), now());
  select count(*) into v_after from inbox.message where conversation_id = v_conv;
  select m.external_message_id into v_txt from inbox.message m where m.id = v_botmsg;
  if v_after = v_before and (r->>'message_id')::uuid = v_botmsg
     and coalesce((r->>'linked_mid')::boolean,false) and r->>'source' = 'bot'
     and v_txt = 'm___selftest__mid_bot1'
    then raise notice ' 7) echo ของบอท mid ตรงคิว     ผ่าน  (ไม่สร้างแถวใหม่ · ผูก mid เข้าแถวเดิม · source=bot)';
    else v_fail := v_fail + 1; raise warning ' 7) echo ของบอท mid ตรงคิว     ★ ตก  before=% after=% r=%', v_before, v_after, r; end if;

  -- ════════ 8) บอทไม่เงียบหลัง echo ของตัวเอง ════════
  select c.last_human_reply_at, c.last_bot_reply_at into v_hr, v_br
    from inbox.conversation c where c.id = v_conv;
  if v_hr is null and v_br is not null
    then raise notice ' 8) บอทไม่เงียบหลัง echo ตัวเอง  ผ่าน  (last_human_reply_at ว่าง · last_bot_reply_at ถูกตั้ง)';
    else v_fail := v_fail + 1; raise warning ' 8) บอทไม่เงียบหลัง echo ตัวเอง  ★ ตก  human=% bot=%', v_hr, v_br; end if;

  -- ════════ 9) echo มาก่อนที่คิวจะบันทึก mid → จับคู่ด้วยข้อความ ════════
  insert into inbox.message(conversation_id, sender_type, content, content_type, event_type)
  values (v_conv, 'bot', 'ว่างอยู่ 3 ห้องค่ะ', 'text', 'message')
  returning id into v_botmsg;
  -- ตั้งใจไม่เซ็ต provider_id (จำลองว่า worker ยัง finish ไม่เสร็จ)
  select count(*) into v_before from inbox.message where conversation_id = v_conv;
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_msgr, 'event_id', 'm___selftest__mid_bot2', 'event_type', 'echo',
         'external_id', 'U__selftest__mcust', 'app_id', BOT_APP,
         'content_type', 'text', 'text', 'ว่างอยู่ 3 ห้องค่ะ', 'occurred_at', now()), now());
  select count(*) into v_after from inbox.message where conversation_id = v_conv;
  if v_after = v_before and (r->>'message_id')::uuid = v_botmsg and coalesce((r->>'linked_mid')::boolean,false)
    then raise notice ' 9) echo มาก่อน mid ถูกบันทึก    ผ่าน  (จับคู่ด้วยข้อความ + หน้าต่างเวลา)';
    else v_fail := v_fail + 1; raise warning ' 9) echo มาก่อน mid ถูกบันทึก    ★ ตก  before=% after=% r=%', v_before, v_after, r; end if;

  -- ════════ 10) echo จาก Page Inbox → คนตอบ + เครดิตจากลายเซ็น ════════
  select count(*) into v_before from inbox.message where conversation_id = v_conv;
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_msgr, 'event_id', 'm___selftest__mid_page1', 'event_type', 'echo',
         'external_id', 'U__selftest__mcust', 'app_id', PAGE_APP,
         'content_type', 'text', 'text', 'เดี๋ยวส่งแปลนให้นะคะ -Mint', 'occurred_at', now()), now());
  select count(*) into v_after from inbox.message where conversation_id = v_conv;
  select m.sender_type into v_txt from inbox.message m where m.id = (r->>'message_id')::uuid;
  select h.source, h.note into v_src, v_note from inbox.human_reply_events h
   where h.conversation_id = v_conv order by h.id desc limit 1;
  select c.last_human_reply_at into v_hr from inbox.conversation c where c.id = v_conv;
  if v_after = v_before + 1 and v_txt = 'agent' and r->>'source' = 'page_inbox'
     and v_src = 'page_inbox' and v_note = 'Mint' and r->>'responder' = 'Mint' and v_hr is not null
    then raise notice '10) echo จาก Page Inbox        ผ่าน  (source=page_inbox · ผู้ตอบ=Mint · นับเป็นคนตอบ)';
    else v_fail := v_fail + 1; raise warning '10) echo จาก Page Inbox        ★ ตก  sender=% src=% note=% r=%', v_txt, v_src, v_note, r; end if;

  -- ════════ 11) echo จากแอปอื่น → other_app ════════
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_msgr, 'event_id', 'm___selftest__mid_other1', 'event_type', 'echo',
         'external_id', 'U__selftest__mcust', 'app_id', '999999999999999',
         'content_type', 'text', 'text', 'ทดสอบจากแอปอื่น', 'occurred_at', now()), now());
  if r->>'source' = 'other_app'
    then raise notice '11) echo จากแอปอื่น            ผ่าน  (source=other_app)';
    else v_fail := v_fail + 1; raise warning '11) echo จากแอปอื่น            ★ ตก  ได้ %', r->>'source'; end if;

  -- ════════ 12) ยิง echo ก้อนเดิมซ้ำ → ด่านกันซ้ำเดิมยังทำงาน ════════
  r := connect_private.receive_event(jsonb_build_object(
         'inbox_id', v_msgr, 'event_id', 'm___selftest__mid_page1', 'event_type', 'echo',
         'external_id', 'U__selftest__mcust', 'app_id', PAGE_APP,
         'content_type', 'text', 'text', 'เดี๋ยวส่งแปลนให้นะคะ -Mint', 'occurred_at', now()), now());
  if coalesce((r->>'duplicate')::boolean, false)
    then raise notice '12) echo ก้อนเดิมยิงซ้ำ         ผ่าน  (inbound_event กันไว้)';
    else v_fail := v_fail + 1; raise warning '12) echo ก้อนเดิมยิงซ้ำ         ★ ตก  ได้ %', r; end if;

  if v_fail = 0 then raise notice '── ผ่านทั้ง 12 ข้อ ──';
  else raise exception 'selftest ตก % ข้อ', v_fail; end if;
end $test$;

delete from connect_private.inbound_event where event_id like '%\_\_selftest\_\_%';
delete from connect_private.job where coalesce(target,'') like '%\_\_selftest\_\_%';
delete from core.contact_identity where external_id like '%\_\_selftest\_\_%';

rollback;
