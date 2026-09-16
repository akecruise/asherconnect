-- =====================================================================
-- 032_worker_resync.sql — กู้ connect_private.worker ที่ถูก sql/002 รันทับ
-- =====================================================================
-- เกิดอะไรขึ้น (2026-09-16 ระหว่าง 04:21–04:34 UTC)
--   มีการรัน sql/002_decide.sql ทั้งไฟล์ใส่โปรดักชันอีกครั้ง ไฟล์นั้น
--   create or replace ของสามชิ้นที่ไฟล์หลัง ๆ เป็นเจ้าของรุ่นล่าสุด
--   ทั้งสามจึงถูกย้อนไปเป็นรุ่น 002 เงียบ ๆ ไม่มีอะไรฟ้อง:
--
--     connect_private.worker         เหลือ 8 action จาก 21  → ตัวส่งข้อความตายทั้งตัว
--     connect_private.receive_event  กิ่ง group_command หาย  → คำสั่งในกลุ่ม LINE ตาย
--     inbox.extract_phone            เสีย fix ของ 014        → จับเบอร์ได้แต่ตัวนำหน้า
--
--   ไฟล์นี้ซ่อม *เฉพาะ worker* เพราะนั่นคือตัวที่ทำให้ส่งข้อความหาลูกค้าไม่ได้
--   อีกสองตัวอยู่ใน 033_receive_event_resync.sql (ยังไม่ได้ลง รออนุมัติ)
--
-- หลักฐานที่ใช้ยืนยันสาเหตุ
--   · นิยาม worker บนฐานตรงกับ sql/002 ทุกตัวอักษร (113 บรรทัด ต่างแค่หัวที่
--     pg_get_functiondef จัดรูปใหม่) — ไม่ใช่รุ่นของ 003 ที่มี claim_job อยู่แล้ว
--   · ดัมพ์ receive_event ตอน 04:21 ยังมี group_command 6 แห่ง · ตอน 04:34 เหลือ 0
--   · job ล่าสุดที่ผ่าน claim_job สำเร็จคือ 04:04:01 → คลอบเบอร์เกิดหลังเวลานั้น
--   · inbox.human_reply_events source='workspace' หยุดที่ 2026-09-15 14:29
--     (กิ่ง finish ที่เรียก mark_human_reply หายไปพร้อมกัน)
--
-- ★ ประกอบจากนิยามที่ครบที่สุดที่มีอยู่ ไม่ได้ลอกไฟล์เก่ามาทับ:
--   asher-web/supabase/migrations/20260915180000_asher_profile_refresh_claim.sql
--   (ไฟล์นั้นเองก็คัดมาจาก pg_get_functiondef() ของฐานจริง) แล้วเติมกิ่ง
--   reset_test ที่ไฟล์นั้นทำหายกลับเข้าไป → 21 action ครบตามที่ server.mjs เรียก
--   สำรองของก่อนแก้: sql/_backup/{worker,receive_event,api}_prod_20260916.sql
--
-- ★ ห้ามรัน sql/002, 003, 004, 007, 008 ใส่ฐานนี้อีก — ทั้งห้าไฟล์ create or
--   replace connect_private.worker ทั้งก้อน ตัวที่รันทีหลังชนะเสมอ ถ้าต้องลงใหม่
--   ทั้งชุดให้ไล่ตาม sql/ORDER.txt ตั้งแต่ต้นจนจบ ห้ามหยุดกลางทาง
--   (ทั้งห้าไฟล์มี guard กันซ้ำแล้ว ดู 033 กับหัวไฟล์แต่ละใบ)
--
-- 21 action: receive log claim_inbound finish_inbound sweep claim finish
--   claim_job finish_job reply_context bot_reply store_intent job_counts
--   mark_blocked send_mode profile_state profile_update profile_backlog
--   profile_refresh_due reset_test health
-- =====================================================================

begin;

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

 elsif p_action='send_mode' then
 -- ★ ตัวจริงของ "โหมดเก็บข้อมูล" ย้ายมาอยู่ที่นี่แล้ว ไม่ใช่ตัวแปรในเครื่องอีกต่อไป
 --   เหตุผล: ค่าที่อยู่ใน env ของแต่ละคอนเทนเนอร์ทำให้ "ตอนนี้ส่งได้หรือยัง" ไม่มีคำตอบเดียว
 --   และเปลี่ยนทีต้องสร้างคอนเทนเนอร์ใหม่ ซึ่งแปลว่าคนหน้างานเปลี่ยนเองไม่ได้
 -- ค่าตั้งต้นมาจาก CONNECT_SHADOW_MODE ของเครื่องที่เรียกมา *ครั้งแรกเท่านั้น*
 -- พอมีแถวแล้ว env ไม่มีผลอีก คนที่กดปุ่มเป็นคนตัดสิน — ไม่งั้น deploy ทีจะกลบสิ่งที่คนตั้งใจไว้
 insert into inbox.bot_config(inbox_id,key,value,note)
 select i.id,'send.live_enabled',to_jsonb(coalesce((p_data->>'default_live')::boolean,false)),
        'ค่าตั้งต้นจาก CONNECT_SHADOW_MODE ตอนบูตครั้งแรก'
   from inbox.inbox i where i.is_active
 on conflict (inbox_id,key) do nothing;
 -- bool_and: ต้องเปิดครบทุกช่องทางถึงจะนับว่า "ส่งจริง"
 -- เปิดครึ่ง ๆ แล้วให้ตัวส่งเดินทั้งระบบ = ช่องที่ยังไม่เปิดจะหลุดออกไปหาลูกค้าด้วย
 return jsonb_build_object(
   'live',coalesce((select bool_and(inbox.cfg_bool(i.id,'send.live_enabled',false))
                      from inbox.inbox i where i.is_active),false),
   'inboxes',coalesce((select jsonb_agg(jsonb_build_object(
       'inbox_id',i.id,'name',i.name,'live',inbox.cfg_bool(i.id,'send.live_enabled',false))
       order by i.name) from inbox.inbox i where i.is_active),'[]'::jsonb));

 elsif p_action='profile_state' then
 -- "ต้องไปดึงโปรไฟล์ของคนนี้ไหม" — ตอบก่อนที่ Node จะยิง API ออกไป
 -- ★ คีย์ต้องครบสามชั้น (channel, account_key, external_id) ไม่ใช่แค่ channel+external_id
 --   userId ของคนเดียวกันต่างกันในแต่ละ OA/แอป ถ้าจับคู่ด้วยสองชั้นจะไปอัปเดตผิดคน
 --   และคีย์นี้ต้องตรงกับที่ core.resolve_identity() ใช้เป๊ะ ๆ (account_key = uuid ของ inbox)
 select ci.contact_id into v_contact
   from core.contact_identity ci
  where ci.channel = p_data->>'channel'
    and ci.account_key = coalesce(p_data->>'account_key','')
    and ci.external_id = p_data->>'external_id';
 if v_contact is null then return jsonb_build_object('due', false, 'reason', 'contact_not_found'); end if;
 return (
   select jsonb_build_object(
     'contact_id', ct.id,
     'status', ct.profile_status,
     'fetched_at', ct.profile_fetched_at,
     -- ดึงเมื่อ: ยังไม่มีชื่อ · ยังไม่เคยดึง · หรือดึงไว้เกิน 7 วันแล้ว
     -- ★ เคสที่ได้ 404 ก็ถูกกันด้วยข้อเดียวกัน เพราะ profile_fetched_at ถูกประทับไว้แล้ว
     --   จึงไม่ยิงซ้ำทุกข้อความ แต่ยังกลับมาลองใหม่ในรอบ 7 วันถัดไป
     'due', (coalesce(btrim(ct.display_name),'') = ''
             or ct.profile_fetched_at is null
             or ct.profile_fetched_at < now() - interval '7 days'))
     from core.contact ct where ct.id = v_contact);

 elsif p_action='profile_update' then
 select ci.contact_id into v_contact
   from core.contact_identity ci
  where ci.channel = p_data->>'channel'
    and ci.account_key = coalesce(p_data->>'account_key','')
    and ci.external_id = p_data->>'external_id';
 if v_contact is null then return jsonb_build_object('ok', false, 'reason', 'contact_not_found'); end if;

 -- ★ ค่าว่างห้ามทับของเดิม — ชื่อที่เซลส์พิมพ์เองต้องไม่ถูกลบเพราะแพลตฟอร์มตอบช้าหรือคืนค่าว่าง
 -- ★ อัปเดตเฉพาะ core.contact เท่านั้น ไม่แตะ inbox.conversation
 --   trigger conversation_updated_at จึงไม่ทำงาน ลำดับใน inbox และ SLA ไม่ขยับ
 update core.contact ct set
   display_name       = coalesce(nullif(btrim(p_data->>'display_name'),''), ct.display_name),
   picture_url        = coalesce(nullif(btrim(p_data->>'picture_url'),''), ct.picture_url),
   profile_fetched_at = now(),
   profile_status     = coalesce(nullif(p_data->>'status',''), 'ok')
  where ct.id = v_contact;

 return jsonb_build_object('ok', true, 'contact_id', v_contact);

 elsif p_action='profile_backlog' then
 -- รายชื่อคนที่ยังไม่มีชื่อ ไว้ให้สคริปต์ backfill ไล่ทีละราย
 -- ★ คืนแค่คีย์ที่จำเป็นต่อการยิง API ไม่คืนชื่อหรือข้อมูลอื่นของลูกค้าออกไป
 -- ★ ข้ามคนที่ขอลบข้อมูลไปแล้ว (anonymized_at) — ห้ามไปดึงกลับมาใหม่
 return coalesce((
   select jsonb_agg(jsonb_build_object(
            'channel', ci.channel,
            'account_key', ci.account_key,
            'external_id', ci.external_id))
     from core.contact_identity ci
     join core.contact ct on ct.id = ci.contact_id
    where ct.anonymized_at is null
      and (coalesce(btrim(ct.display_name),'') = ''
           or (coalesce((p_data->>'include_stale')::boolean, false)
               and (ct.profile_fetched_at is null
                    or ct.profile_fetched_at < now() - interval '7 days')))
    limit greatest(1, least(coalesce((p_data->>'limit')::int, 500), 2000))), '[]'::jsonb);

 elsif p_action='profile_refresh_due' then
 -- "ถึงรอบรีเฟรชประจำวันหรือยัง" — ตอบ true ได้วันละครั้งเท่านั้น
 --
 -- ★ ทำไมไม่ใช้ pg_cron: pg_cron เรียก HTTP ออกไปข้างนอกไม่ได้ แต่การดึงโปรไฟล์
 --   ต้องยิง API ของ LINE/Meta จึงต้องให้ฝั่ง Node เป็นคนทำ
 -- ★ ทำไมไม่ใช้ setInterval เปล่า ๆ ใน Node: ตัวนับเริ่มใหม่ทุกครั้งที่ deploy
 --   วันที่ deploy หลายรอบจะไม่ได้รีเฟรชเลยสักครั้งโดยไม่มีใครรู้
 --   เก็บ "ครั้งล่าสุดเมื่อไหร่" ไว้ในฐานแทน จึงรอดทั้งการ restart และการ deploy
 --
 -- ★ ต้องเป็นคำสั่งเดียวที่อ่านและประทับเวลาพร้อมกัน ไม่งั้นถ้ามีหลายคอนเทนเนอร์
 --   สองตัวจะอ่านพร้อมกันแล้วได้ true ทั้งคู่ แล้วยิง API ซ้ำสองเท่า
 with claimed as (
   insert into inbox.settings(key, value, note)
   values ('profile_refresh_at', to_jsonb(now()), 'รอบรีเฟรชโปรไฟล์ลูกค้าล่าสุด')
   on conflict (key) do update
      set value = to_jsonb(now()), updated_at = now()
    where (inbox.settings.value #>> '{}')::timestamptz
          < now() - make_interval(hours => greatest(1, coalesce((p_data->>'every_hours')::int, 24)))
   returning 1)
 select jsonb_build_object('due', exists(select 1 from claimed)) into v_result;
 return v_result;

 elsif p_action='reset_test' then
 -- ★ กิ่งนี้มีใน sql/003 แต่หายจากนิยามที่ asher-web เขียนทับเมื่อ 2026-09-15
 --   (ไฟล์นั้นคัดมาจาก pg_get_functiondef() ของฐานที่ *ตอนนั้น* ก็ไม่มีกิ่งนี้แล้ว)
 --   server.mjs:867 เรียก action นี้อยู่จริง ขาดไปแล้วคำสั่ง "test" ของทีมพัง
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

-- create or replace ไม่ล้าง ACL เดิม บรรทัดนี้ไว้เผื่อฐานที่ตั้งใหม่
grant execute on function connect_private.worker(text,jsonb) to service_role;

commit;
