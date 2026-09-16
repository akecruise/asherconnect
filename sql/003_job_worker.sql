-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 — ทางที่ worker ใช้คุยกับคิว
--
-- เพิ่ม action ให้ connect_private.worker เท่านั้น ไม่แตะของเดิมสักตัว
--   claim_job      หยิบงานจาก connect_private.job ตามชนิดที่อนุญาต
--   finish_job     ปิดงาน พร้อม backoff
--   reply_context  ของที่ต้องใช้คิดคำตอบ + เหตุผลที่ควรเลิกคิด (ถ้ามี)
--   bot_reply      บันทึกคำตอบของบอท (trigger จะพามันเข้าคิวขาออกเอง)
--   store_intent   เก็บหมวดคำถามที่ถอดได้
--
-- ★ ชนิดงานที่หยิบได้ถูกจำกัดด้วย "รายการที่ผู้เรียกส่งมา" ไม่ใช่ด้วย if ในโค้ด
--   โหมดเงาจึงกันการส่งด้วยการไม่ขอชนิดนั้นมาตั้งแต่แรก งานส่งจะไม่ถูกแตะเลย
--   ไม่ใช่หยิบมาแล้วค่อยตัดสินใจว่าจะไม่ส่ง ซึ่งพลาดได้ถ้าใครเผลอลบ if นั้นทิ้ง
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── guard: ห้ามย้อนรุ่นของที่ไฟล์หลัง ๆ เป็นเจ้าของ ─────────────────────
-- ★ วางไว้เป็น "คำสั่งแรกหลัง begin; ของ transaction แรก" โดยตั้งใจ
--   ไฟล์นี้มีได้หลาย transaction — ถ้า guard อยู่ใน transaction ท้าย ๆ
--   transaction แรกจะ commit ไปแล้วก่อนที่ guard จะทัน raise
--   (เกิดจริง 2026-09-16: guard รุ่นแรกอยู่ใน tx ที่สองของ sql/002
--    ซึ่งกัน worker ได้ แต่ receive_event/extract_phone ใน tx แรกยังหลุด)
--
-- ★ เหตุที่ต้องมี: 2026-09-16 ราว 04:21 UTC มีการรัน sql/002_decide.sql
--   ทั้งไฟล์ใส่โปรดักชัน สามชิ้นที่ไฟล์หลัง ๆ เป็นเจ้าของรุ่นล่าสุดถูกย้อนรุ่น
--   เงียบ ๆ ไม่มีอะไรฟ้อง:
--     connect_private.worker        เหลือ 8 จาก 21 action → ส่งข้อความหาลูกค้าไม่ได้ 37 นาที
--     connect_private.receive_event กิ่ง group_command หาย → คำสั่งในกลุ่ม LINE ตาย
--     inbox.extract_phone           เสีย fix ของ 014 → จับเบอร์ลูกค้าไม่ได้
--   รายละเอียดทั้งหมดอยู่ใน sql/032_worker_resync.sql และ sql/033_receive_event_resync.sql
do $guard$
declare v_newer text[] := '{}';
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'connect_private' and p.proname = 'worker'
                and strpos(pg_get_functiondef(p.oid), 'profile_refresh_due') > 0)
    then v_newer := v_newer || 'connect_private.worker รุ่น 032 (21 action)'::text; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'connect_private' and p.proname = 'receive_event'
                and strpos(pg_get_functiondef(p.oid), 'group_command') > 0)
    then v_newer := v_newer || 'connect_private.receive_event มีกิ่ง group_command (sql/006 ขึ้นไป)'::text; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'connect_private' and p.proname = 'receive_event'
                and strpos(pg_get_functiondef(p.oid), 'is_test') > 0)
    then v_newer := v_newer || 'connect_private.receive_event มีธง is_test (sql/031 + 033)'::text; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'inbox' and p.proname = 'extract_phone'
                and strpos(pg_get_functiondef(p.oid), 'วงเล็บนอกสุดครอบทั้งก้อน') > 0)
    then v_newer := v_newer || 'inbox.extract_phone รุ่น 014 (วงเล็บนอกสุด)'::text; end if;

  if array_length(v_newer, 1) > 0 then
    raise exception 'ฐานนี้มีรุ่นที่ใหม่กว่าไฟล์นี้อยู่แล้ว: % — ไฟล์นี้จะทำของหายเงียบ ๆ จึงหยุดก่อนที่จะมีอะไร commit. ถ้าต้องลงใหม่ทั้งชุด ให้ไล่ตาม sql/ORDER.txt ตั้งแต่ต้นจนจบ (032/033 อยู่ท้ายสุด) ห้ามหยุดกลางทาง',
      array_to_string(v_newer, ' · ');
  end if;
end $guard$;


create or replace function connect_private.claim_job(p_kinds text[], p_inbox_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  -- โพรเซสที่ถือของไว้แล้วตายกลางทาง ปล่อยกลับเข้าคิว
  update connect_private.job set status = 'pending', lease_id = null
   where status = 'processing' and locked_at < now() - interval '2 minutes';

  with picked as (
    select j.id from connect_private.job j
     where j.status = 'pending' and j.send_after <= now()
       and j.kind = any(p_kinds)
       and (p_inbox_ids is null or j.inbox_id = any(p_inbox_ids))
     order by j.send_after, j.id
     limit 1 for update skip locked
  ), updated as (
    update connect_private.job j
       set status = 'processing', attempts = attempts + 1, locked_at = now(), lease_id = gen_random_uuid()
      from picked p where j.id = p.id returning j.*
  )
  select to_jsonb(u) || jsonb_build_object(
           'channel_of_inbox', (select i.channel from inbox.inbox i where i.id = u.inbox_id))
    into v_result from updated u;
  return v_result;
end $$;


create or replace function connect_private.finish_job(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare j connect_private.job; v_status text;
begin
  select * into j from connect_private.job where id = (p_data->>'job_id')::bigint for update;
  if not found or j.status <> 'processing' or j.lease_id is distinct from (p_data->>'lease_id')::uuid then
    raise exception 'stale_lease';
  end if;

  v_status := coalesce(p_data->>'status', 'failed');
  if v_status = 'sent' then v_status := 'done'; end if;

  if v_status in ('done', 'skipped', 'uncertain', 'failed') then
    update connect_private.job
       set status = v_status, finished_at = now(), lease_id = null,
           provider_id = coalesce(p_data->>'provider_id', provider_id),
           skip_reason = coalesce(p_data->>'skip_reason', skip_reason),
           last_error = left(p_data->>'error', 200)
     where id = j.id;
  else
    -- retry: ถอยออกไปตามจำนวนครั้งที่ลองแล้ว เพดาน 15 นาที
    update connect_private.job
       set status = case when attempts < 5 then 'pending' else 'failed' end,
           send_after = now() + make_interval(secs => least(900, 30 * attempts)),
           last_error = left(p_data->>'error', 200), lease_id = null
     where id = j.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;


/**
 * ของที่ต้องใช้คิดคำตอบ — และเหตุผลที่ *ไม่ควรคิดต่อ* ถ้ามี
 *
 * เหตุผลที่ต้องเช็คอีกรอบตอนจะตอบ ไม่ใช่แค่ตอนเข้าคิว:
 * ระหว่างที่งานรออยู่ในคิว (อาจ 30 นาที) คนอาจตอบไปแล้ว หรือปิดบอทไปแล้ว
 * ของเดิมเช็คตรงนี้เหมือนกัน (queueSkipReason) — ถ้าไม่เช็ค ลูกค้าจะได้คำตอบซ้อนจากคนกับบอท
 */
create or replace function connect_private.reply_context(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid; c inbox.conversation; v_limit int; v_skip text; v_msg_at timestamptz;
  v_history jsonb; v_phone text; v_project text; v_today date; v_offtopic int;
begin
  v_id := (p_data->>'conversation_id')::uuid;
  select * into c from inbox.conversation where id = v_id;
  if not found then return jsonb_build_object('skip_reason', 'conversation_missing'); end if;

  v_msg_at := coalesce((p_data->>'since')::timestamptz, c.created_at);
  if c.last_human_reply_at is not null and c.last_human_reply_at > v_msg_at then v_skip := 'human_replied';
  elsif c.last_bot_reply_at is not null and c.last_bot_reply_at > v_msg_at then v_skip := 'bot_already_replied';
  elsif coalesce(c.mode, 'bot') <> 'bot' then v_skip := 'mode_' || coalesce(c.mode, 'bot');
  end if;

  v_limit := coalesce((p_data->>'history_limit')::int, 12);
  select jsonb_agg(jsonb_build_object('role', case when m.sender_type = 'contact' then 'user' else 'assistant' end,
                                      'content', m.content) order by m.created_at)
    into v_history
    from (select * from inbox.message where conversation_id = v_id order by created_at desc limit v_limit) m;

  select ct.phone into v_phone from core.contact ct where ct.id = c.contact_id;
  select p.code into v_project from core.project p join inbox.inbox i on i.project_id = p.id where i.id = c.inbox_id;

  v_today := (now() at time zone 'Asia/Bangkok')::date;
  v_offtopic := case when c.offtopic_date = v_today then coalesce(c.offtopic_count, 0) else 0 end;

  -- สไตล์การตอบมาจากฐาน ไม่ใช่ค่าคงที่ใน Node — ปรับต่อ inbox ได้โดยไม่ต้อง deploy
  return jsonb_build_object(
    'skip_reason', v_skip,
    'history', coalesce(v_history, '[]'::jsonb),
    'known_phone', v_phone,
    'ad_title', c.ad_title,
    'ad_id', c.ad_id,
    'project', coalesce(v_project, 'naii'),
    'offtopic_count', v_offtopic,
    'offtopic_limit', inbox.cfg_int(c.inbox_id, 'reply.offtopic_daily_limit', 3),
    'history_limit', inbox.cfg_int(c.inbox_id, 'reply.history_limit', 12),
    'model', inbox.cfg_text(c.inbox_id, 'reply.model', 'claude-haiku-4-5-20251001'),
    'min_confidence', (inbox.cfg_text(c.inbox_id, 'insight.min_confidence', '0.6'))::numeric,
    'style', jsonb_build_object(
      'tone',                        inbox.cfg_text(c.inbox_id, 'style.tone', 'warm'),
      'max_sentences',               inbox.cfg_int(c.inbox_id, 'style.max_sentences', 4),
      'answer_first',                inbox.cfg_bool(c.inbox_id, 'style.answer_first', true),
      'numbers_required',            inbox.cfg_bool(c.inbox_id, 'style.numbers_required', true),
      'use_emoji',                   inbox.cfg_text(c.inbox_id, 'style.use_emoji', 'light'),
      'cta',                         inbox.cfg_text(c.inbox_id, 'style.cta', 'when_interested'),
      'ask_contact',                 inbox.cfg_text(c.inbox_id, 'style.ask_contact', 'when_interested'),
      'greet_new_chat',              inbox.cfg_bool(c.inbox_id, 'style.greet_new_chat', true),
      'greet_returning',             inbox.cfg_bool(c.inbox_id, 'style.greet_returning', false),
      'resend_brochure_to_returning', inbox.cfg_bool(c.inbox_id, 'style.resend_brochure_to_returning', false),
      'polite_particle',             inbox.cfg_text(c.inbox_id, 'style.polite_particle', 'ค่ะ')),
    'is_new_chat', coalesce((p_data->>'is_new_chat')::boolean, false));
end $$;


/**
 * บันทึกคำตอบของบอท
 *
 * ไม่ได้สร้างงานส่งเอง — trigger inbox.enqueue_outbound เป็นคนพาเข้าคิวขาออก
 * เหมือนกับตอนที่เซลส์กดส่งเองทุกประการ ทางส่งจึงมีทางเดียวทั้งระบบ
 */
create or replace function connect_private.bot_reply(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid; v_message uuid; v_today date;
begin
  v_id := (p_data->>'conversation_id')::uuid;
  if coalesce(p_data->>'text', '') = '' then raise exception 'invalid_message'; end if;

  insert into inbox.message(conversation_id, sender_type, content, content_type, event_type)
  values (v_id, 'bot', p_data->>'text', 'text', 'message')
  returning id into v_message;

  update inbox.conversation set last_bot_reply_at = now() where id = v_id;

  if coalesce((p_data->>'offtopic')::boolean, false) then
    v_today := (now() at time zone 'Asia/Bangkok')::date;
    update inbox.conversation
       set offtopic_count = case when offtopic_date = v_today then coalesce(offtopic_count, 0) + 1 else 1 end,
           offtopic_date = v_today
     where id = v_id;
  end if;

  return jsonb_build_object('message_id', v_message);
end $$;


create or replace function connect_private.store_intent(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_id bigint;
begin
  insert into inbox.message_intents(
    conversation_id, message_id, contact_hash, channel, project,
    primary_topic, primary_l2, secondary_topics, stage, objection, budget_signal, urgency,
    confidence, classifier, raw_question, ad_id, ad_title, is_new_chat, bot_replied)
  select (p_data->>'conversation_id')::uuid,
         nullif(p_data->>'message_id','')::uuid,
         -- แฮชของผู้ติดต่อ ไม่ใช่ตัว id — ตารางนี้ไว้ดูภาพรวม ไม่ควรชี้กลับไปหาคนได้ง่าย ๆ
         -- ★ ต้องเขียน extensions.digest ให้เต็ม: pgcrypto อยู่ schema extensions
         --   แต่ search_path ของฟังก์ชันนี้มีแค่ pg_catalog, public (ตั้งไว้แคบโดยตั้งใจ
         --   เพราะเป็น security definer) จะเรียก digest() ลอย ๆ ไม่เจอ
         --   อาการเดิม: 404 function digest(text, unknown) does not exist → classify ล้มทุกงาน
         encode(extensions.digest(coalesce(p_data->>'external_id','') || coalesce(p_data->>'salt','asher'), 'sha256'), 'hex'),
         i.channel, p_data->>'project',
         p_data->>'primary_topic', nullif(p_data->>'primary_l2',''),
         coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_data->'secondary_topics','[]'::jsonb))), '{}'),
         nullif(p_data->>'stage',''), nullif(p_data->>'objection',''),
         nullif(p_data->>'budget_signal',''), nullif(p_data->>'urgency',''),
         (p_data->>'confidence')::numeric, nullif(p_data->>'classifier',''),
         left(p_data->>'raw_question', 500), nullif(p_data->>'ad_id',''), nullif(p_data->>'ad_title',''),
         (p_data->>'is_new_chat')::boolean, (p_data->>'bot_replied')::boolean
    from inbox.conversation c join inbox.inbox i on i.id = c.inbox_id
   where c.id = (p_data->>'conversation_id')::uuid
  returning id into v_id;
  return jsonb_build_object('intent_id', v_id);
end $$;

create extension if not exists pgcrypto;

revoke all on function connect_private.claim_job(text[],uuid[]), connect_private.finish_job(jsonb),
                      connect_private.reply_context(jsonb), connect_private.bot_reply(jsonb),
                      connect_private.store_intent(jsonb)
  from public, anon, authenticated;
grant execute on function connect_private.claim_job(text[],uuid[]), connect_private.finish_job(jsonb),
                          connect_private.reply_context(jsonb), connect_private.bot_reply(jsonb),
                          connect_private.store_intent(jsonb)
  to service_role;

commit;


-- ═══════════════════════════════════════════════════════════════════════════
-- ต่อ action ใหม่เข้ากับ connect_private.worker
--
-- ยกทั้งฟังก์ชันมาเพราะ plpgsql แทนที่ได้ทีละทั้งตัว — ดึงนิยามปัจจุบันจากฐานด้วยสคริปต์
-- แล้วแทรกเฉพาะ branch ใหม่ ของเดิมจึงเหมือนเดิมทุกบรรทัดโดยไม่ต้องพิมพ์ใหม่
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── guard: ห้ามย้อนรุ่นของที่ไฟล์หลัง ๆ เป็นเจ้าของ ─────────────────────
-- ★ วางไว้เป็น "คำสั่งแรกหลัง begin; ของ transaction แรก" โดยตั้งใจ
--   ไฟล์นี้มีได้หลาย transaction — ถ้า guard อยู่ใน transaction ท้าย ๆ
--   transaction แรกจะ commit ไปแล้วก่อนที่ guard จะทัน raise
--   (เกิดจริง 2026-09-16: guard รุ่นแรกอยู่ใน tx ที่สองของ sql/002
--    ซึ่งกัน worker ได้ แต่ receive_event/extract_phone ใน tx แรกยังหลุด)
--
-- ★ เหตุที่ต้องมี: 2026-09-16 ราว 04:21 UTC มีการรัน sql/002_decide.sql
--   ทั้งไฟล์ใส่โปรดักชัน สามชิ้นที่ไฟล์หลัง ๆ เป็นเจ้าของรุ่นล่าสุดถูกย้อนรุ่น
--   เงียบ ๆ ไม่มีอะไรฟ้อง:
--     connect_private.worker        เหลือ 8 จาก 21 action → ส่งข้อความหาลูกค้าไม่ได้ 37 นาที
--     connect_private.receive_event กิ่ง group_command หาย → คำสั่งในกลุ่ม LINE ตาย
--     inbox.extract_phone           เสีย fix ของ 014 → จับเบอร์ลูกค้าไม่ได้
--   รายละเอียดทั้งหมดอยู่ใน sql/032_worker_resync.sql และ sql/033_receive_event_resync.sql
do $guard$
declare v_newer text[] := '{}';
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'connect_private' and p.proname = 'worker'
                and strpos(pg_get_functiondef(p.oid), 'profile_refresh_due') > 0)
    then v_newer := v_newer || 'connect_private.worker รุ่น 032 (21 action)'::text; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'connect_private' and p.proname = 'receive_event'
                and strpos(pg_get_functiondef(p.oid), 'group_command') > 0)
    then v_newer := v_newer || 'connect_private.receive_event มีกิ่ง group_command (sql/006 ขึ้นไป)'::text; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'connect_private' and p.proname = 'receive_event'
                and strpos(pg_get_functiondef(p.oid), 'is_test') > 0)
    then v_newer := v_newer || 'connect_private.receive_event มีธง is_test (sql/031 + 033)'::text; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'inbox' and p.proname = 'extract_phone'
                and strpos(pg_get_functiondef(p.oid), 'วงเล็บนอกสุดครอบทั้งก้อน') > 0)
    then v_newer := v_newer || 'inbox.extract_phone รุ่น 014 (วงเล็บนอกสุด)'::text; end if;

  if array_length(v_newer, 1) > 0 then
    raise exception 'ฐานนี้มีรุ่นที่ใหม่กว่าไฟล์นี้อยู่แล้ว: % — ไฟล์นี้จะทำของหายเงียบ ๆ จึงหยุดก่อนที่จะมีอะไร commit. ถ้าต้องลงใหม่ทั้งชุด ให้ไล่ตาม sql/ORDER.txt ตั้งแต่ต้นจนจบ (032/033 อยู่ท้ายสุด) ห้ามหยุดกลางทาง',
      array_to_string(v_newer, ' · ');
  end if;
end $guard$;


CREATE OR REPLACE FUNCTION connect_private.worker(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_inbox inbox.inbox; v_contact uuid; v_id uuid; v_message uuid; v_lead uuid;
 v_delivery connect_private.delivery; v_msg inbox.message;
 v_result jsonb; v_first boolean; v_time timestamptz;
 v_event_type text; v_log bigint; v_row connect_private.webhook_log;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_only' using errcode='42501'; end if;

 if p_action='receive' then
 -- ★ ตรรกะย้ายไป connect_private.receive() แล้ว (Phase 3)
 --   ที่นี่เหลือแค่ทางเข้า เพื่อให้ผู้เรียกเดิมไม่ต้องรู้ว่าข้างในเปลี่ยน
 return connect_private.receive(p_data);

 elsif p_action='log' then
 -- ทางเข้าของ webhook: เก็บของดิบให้จบแล้วปล่อยให้ผู้ส่งไปทำอย่างอื่นต่อ
 -- ตรงนี้ต้องเบาที่สุดในระบบ เพราะ LINE/Meta รออยู่ปลายสาย
 if coalesce(p_data->>'channel_key','')='' or coalesce(p_data->>'channel','')='' then raise exception 'invalid_event'; end if;
 insert into connect_private.webhook_log(channel_key,channel,inbox_id,payload)
 values(p_data->>'channel_key',p_data->>'channel',nullif(p_data->>'inbox_id','')::uuid,coalesce(p_data->'payload','{}'::jsonb))
 returning id into v_log;
 return jsonb_build_object('log_id',v_log);

 elsif p_action='claim_inbound' then
 -- โพรเซสที่ถือของไว้แล้วตายกลางทาง ปล่อยของกลับเข้าคิว
 -- ขาเข้าทำซ้ำได้ปลอดภัยเสมอ เพราะ inbound_event กันซ้ำอยู่แล้ว จึงไม่ต้องมีสถานะ uncertain แบบขาออก
 update connect_private.webhook_log set status='pending',lease_id=null
  where status='processing' and locked_at<now()-interval '2 minutes';
 with picked as (
   select w.id from connect_private.webhook_log w
    where w.status='pending' and w.available_at<=now()
      and w.channel_key in (select value from jsonb_array_elements_text(coalesce(p_data->'channel_keys','[]')))
    order by w.id limit 1 for update skip locked
 ), updated as (
   update connect_private.webhook_log w set status='processing',attempts=attempts+1,locked_at=now(),lease_id=gen_random_uuid()
    from picked p where w.id=p.id returning w.*
 ) select to_jsonb(u) into v_result from updated u;
 return v_result;

 elsif p_action='finish_inbound' then
 select * into v_row from connect_private.webhook_log where id=(p_data->>'log_id')::bigint for update;
 if not found or v_row.status<>'processing' or v_row.lease_id is distinct from (p_data->>'lease_id')::uuid then
   raise exception 'stale_lease';
 end if;
 if coalesce(p_data->>'status','')='done' then
   update connect_private.webhook_log set status='done',processed_at=now(),lease_id=null,last_error=null,
          events_count=coalesce((p_data->>'events_count')::int,0)
    where id=v_row.id;
 else
   -- ของดิบยังอยู่เสมอ ต่อให้ทำไม่สำเร็จ — ล้มเลิกแค่การประมวลผล ไม่ใช่ทิ้งหลักฐาน
   update connect_private.webhook_log
      set status=case when v_row.attempts<5 then 'pending' else 'failed' end,
          available_at=now()+make_interval(secs=>least(900,30*v_row.attempts)),
          last_error=left(p_data->>'error',200), lease_id=null
    where id=v_row.id;
 end if;
 return jsonb_build_object('ok',true);

 elsif p_action='sweep' then
 -- ในของดิบมีข้อความลูกค้าจริง เก็บเท่าที่ใช้ประโยชน์ได้แล้วลบ
 with gone as (delete from connect_private.webhook_log where received_at<now()-interval '30 days' returning 1)
 select jsonb_build_object('deleted',count(*)) into v_result from gone;
 return v_result;

 elsif p_action='claim' then
 -- A crashed non-idempotent Messenger send is uncertain and must not be resent automatically.
 update connect_private.delivery d set status='uncertain',last_error='delivery_confirmation_lost',lease_id=null
 from inbox.message m join inbox.conversation c on c.id=m.conversation_id join inbox.inbox i on i.id=c.inbox_id
 where d.message_id=m.id and d.status='processing' and d.locked_at<now()-interval '2 minutes' and i.channel<>'line';
 with picked as (
 select d.message_id from connect_private.delivery d join inbox.message m on m.id=d.message_id join inbox.conversation c on c.id=m.conversation_id join inbox.inbox i on i.id=c.inbox_id
 where i.is_active and i.id in (select value::uuid from jsonb_array_elements_text(coalesce(p_data->'inbox_ids','[]')))
 and d.available_at<=now() and (d.status='pending' or (d.status='processing' and d.locked_at<now()-interval '2 minutes' and i.channel='line'))
 and not exists(select 1 from connect_private.delivery older join inbox.message om on om.id=older.message_id where om.conversation_id=m.conversation_id and older.status in ('pending','processing','uncertain') and (om.created_at,om.id)<(m.created_at,m.id))
 order by d.created_at limit 1 for update of d skip locked
 ), updated as (update connect_private.delivery d set status='processing',attempts=attempts+1,locked_at=now(),lease_id=gen_random_uuid() from picked p where d.message_id=p.message_id returning d.*)
 select to_jsonb(u)||jsonb_build_object('text',m.content,'channel',i.channel,'inbox_id',i.id,'recipient',ci.external_id,'last_inbound_at',(select max(created_at) from inbox.message where conversation_id=c.id and sender_type='contact')) into v_result
 from updated u join inbox.message m on m.id=u.message_id join inbox.conversation c on c.id=m.conversation_id join inbox.inbox i on i.id=c.inbox_id
 left join core.contact_identity ci on ci.contact_id=c.contact_id and ci.channel=i.channel and ci.account_key=i.id::text;
 return v_result;

 elsif p_action='finish' then
 select * into v_delivery from connect_private.delivery where message_id=(p_data->>'message_id')::uuid for update;
 if not found or v_delivery.status<>'processing' or v_delivery.lease_id is distinct from (p_data->>'lease_id')::uuid then raise exception 'stale_lease'; end if;
 select * into strict v_msg from inbox.message where id=v_delivery.message_id;
 perform 1 from inbox.conversation where id=v_msg.conversation_id for update;
 if p_data->>'status'='sent' then
 update connect_private.delivery set status='sent',provider_id=p_data->>'provider_id',last_error=null,lease_id=null where message_id=v_delivery.message_id;
 update inbox.message set delivered_at=now() where id=v_delivery.message_id;
 select first_human_response_at is null into v_first from connect_private.case_state where conversation_id=v_msg.conversation_id;
 update connect_private.case_state set first_human_response_at=coalesce(first_human_response_at,now()),waiting_since=(select min(created_at) from inbox.message where conversation_id=v_msg.conversation_id and sender_type='contact' and created_at>v_msg.created_at) where conversation_id=v_msg.conversation_id;
 update inbox.conversation set sla_due_at=(select waiting_since+interval '30 minutes' from connect_private.case_state where conversation_id=v_msg.conversation_id) where id=v_msg.conversation_id;
 perform connect_private.emit(v_msg.conversation_id,'message_sent',jsonb_build_object('message_id',v_msg.id,'provider_id',p_data->>'provider_id'),v_msg.sender_id);
 if v_first then perform connect_private.emit(v_msg.conversation_id,'human_first_response',jsonb_build_object('message_id',v_msg.id),v_msg.sender_id); end if;
 else
 update connect_private.delivery set status=case when p_data->>'status'='uncertain' then 'uncertain' when p_data->>'status'='retry' and attempts<5 then 'pending' else 'failed' end,
 available_at=now()+make_interval(secs=>least(900,30*attempts)),last_error=left(p_data->>'error',200),lease_id=null where message_id=v_delivery.message_id;
 end if;
 return jsonb_build_object('ok',true);

 elsif p_action='claim_job' then
 return connect_private.claim_job(
   coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_data->'kinds','[]'::jsonb))), '{}'::text[]),
   (select array_agg((value #>> '{}')::uuid) from jsonb_array_elements(coalesce(p_data->'inbox_ids','[]'::jsonb))));

 elsif p_action='finish_job' then
 return connect_private.finish_job(p_data);

 elsif p_action='reply_context' then
 return connect_private.reply_context(p_data);

 elsif p_action='bot_reply' then
 return connect_private.bot_reply(p_data);

 elsif p_action='store_intent' then
 return connect_private.store_intent(p_data);

 elsif p_action='reset_test' then
 return connect_private.reset_test_conversation(p_data);

 elsif p_action='health' then
 return jsonb_build_object(
   'pending',(select count(*) from connect_private.delivery where status in ('pending','processing')),
   'failed',(select count(*) from connect_private.delivery where status in ('failed','uncertain')),
   'inbound_pending',(select count(*) from connect_private.webhook_log where status in ('pending','processing')),
   'inbound_failed',(select count(*) from connect_private.webhook_log where status='failed'));
 end if;
 raise exception 'unknown_action';
end $function$;

revoke all on function connect_private.worker(text,jsonb) from public,anon,authenticated;
grant execute on function connect_private.worker(text,jsonb) to service_role;

commit;
