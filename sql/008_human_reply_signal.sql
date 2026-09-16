-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 — ต่อสัญญาณ "คนตอบแล้ว" ตัวหลักให้ครบ
--
-- PLAN เขียนไว้ว่าสัญญาณหลักคือเซลส์กดส่งจาก Sales Workspace
-- ส่วนคำสั่งในกลุ่มกับ endpoint เป็นทางสำรองช่วงเปลี่ยนผ่าน
--
-- ตรวจแล้วพบว่าทางหลักยังไม่ได้ต่อ — worker('finish') อัปเดตแต่
-- case_state.first_human_response_at ซึ่งเป็น "ครั้งแรกในชีวิตของเคส"
-- ไม่ใช่ last_human_reply_at ที่ decide_reply ใช้ตัดสิน human_owns_convo
--
-- ผลถ้าไม่แก้: เซลส์ตอบลูกค้าไปแล้ว บอทก็ยังคิดว่าไม่มีใครตอบ แล้วตอบซ้อนเข้าไปอีก
-- ซึ่งเป็นอาการที่ลูกค้าเห็นโดยตรง
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
 select to_jsonb(u)||jsonb_build_object('text',m.content,'channel',i.channel,'inbox_id',i.id,'recipient',ci.external_id,'last_inbound_at',(select max(created_at) from inbox.message where conversation_id=c.id and sender_type='contact'),'conversation_id',c.id,'reply_token',c.last_reply_token,'reply_token_age_sec',case when c.last_reply_token_at is null then null else extract(epoch from (now()-c.last_reply_token_at))::int end,'reply_token_max_sec',inbox.cfg_int(i.id,'delay.reply_token_max_sec',20)) into v_result
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
 -- ★ สัญญาณ "คนตอบแล้ว" ตัวหลักตาม PLAN: เซลส์กดส่งจากหน้าจอเรา
 --   ส่งถึงลูกค้าแล้วเท่านั้นจึงนับ — ยังอยู่ในคิวไม่นับ เพราะลูกค้ายังไม่ได้ยินอะไร
 --   คำสั่งในกลุ่มกับ endpoint human_reply เป็นทางสำรองช่วงเปลี่ยนผ่านเท่านั้น
 --   ทุกทางจบที่ mark_human_reply() ตัวเดียวกัน จะได้ไม่มีทางไหนลืมยกเลิกงานที่บอทจ่อจะส่ง
 if v_msg.sender_type='agent' then
   perform connect_private.mark_human_reply(v_msg.conversation_id, null, 'workspace', now());
 end if;
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

 elsif p_action='job_counts' then
 return connect_private.job_counts();

 elsif p_action='mark_blocked' then
 return connect_private.mark_blocked(p_data);

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
