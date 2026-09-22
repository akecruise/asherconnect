-- 202609221400_manual_name_guard.sql
--
-- ชื่อที่คนตั้งเอง ห้ามให้ตัวดึงโปรไฟล์ทับ — ถาวร
--
-- ปัญหาเดิม: connect_private.worker กิ่ง 'profile_update' เขียน
--   display_name = coalesce(<ค่าใหม่จากแพลตฟอร์ม>, <ของเดิม>)
-- ซึ่งแปลว่า "ถ้าแพลตฟอร์มคืนชื่อมา ให้ทับของเดิมทันที" สิ่งที่กันไว้มีแค่
-- ค่าว่างเท่านั้น ไม่ได้กันชื่อที่เซลส์พิมพ์เอง
--
-- ★ ทำไมถึงสำคัญกว่าที่คิด: server.mjs เรียก profile_backlog ด้วย
--   include_stale:true ทุกวัน (refreshProfiles) ซึ่งดึงคนที่ profile_fetched_at
--   เกิน 7 วัน *ไม่ว่าจะมีชื่ออยู่แล้วหรือไม่* ชื่อที่ตั้งเองจึงถูกทับทุก 7 วัน
--   โดยไม่มีอะไรฟ้อง ตอนตรวจพบมี LINE 18 ราย / contact ทั้งหมด 78 รายที่เสี่ยง
--
-- แก้สองจุด:
--   1. connect_private.worker  กิ่ง profile_update — เคารพ extra->>'name_source'
--   2. connect_private.api     กิ่ง 'save' — ตอนคนแก้ชื่อเอง ให้ประทับ
--      name_source='manual' ไว้ด้วย ไม่งั้นข้อ 1 ไม่มีอะไรให้ดู
--      ★ ถ้าล้างชื่อทิ้ง (ค่าว่าง) ให้ *ถอด* เครื่องหมายออก เพื่อให้ตัวดึง
--        กลับมาเติมชื่อให้ได้ตามปกติ ไม่งั้นล้างครั้งเดียวจะว่างตลอดไป
--
-- ★ ทั้งสองฟังก์ชันคัดจาก pg_get_functiondef() ของจริงบน VPS เมื่อ 2026-09-22
--   ด้วยเหตุผลเดียวกับที่ sql/026 เตือนไว้ — ประกอบใหม่จากไฟล์เก่าจะทำให้ของที่
--   แก้สดบนฐาน (เช่น api.patched.20260920) หายเงียบ ๆ
--   ตรวจแล้วว่า worker บนฐาน = sql/032_worker_resync.sql ทุกตัวอักษรในกิ่งนี้
--
-- ★ additive ล้วน — ไม่มี DDL ไม่สร้าง/ลบคอลัมน์ ไม่แตะข้อมูล ไม่แตะ
--   เส้นทาง Messenger backfill (sql/022_contact_profile_sync.sql ไม่ถูกแตะ)
--
-- ย้อนกลับ: รัน /opt/asher-inbox/rollback/202609221400/{worker,api}.sql
--   (ดัมป์ของเดิมเก็บไว้ก่อนลง — ดูรายงานการ deploy)

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
   display_name       = case
                          when coalesce(ct.extra->>'name_source','') = 'manual'
                            then ct.display_name
                          else coalesce(nullif(btrim(p_data->>'display_name'),''), ct.display_name)
                        end,
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

CREATE OR REPLACE FUNCTION connect_private.api(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
declare v_actor uuid:=auth.uid(); v_role text; v_id uuid; c inbox.conversation; l crm.lead; v_lead uuid;
 v_request uuid; v_result jsonb; v_old connect_private.command; v_target uuid; v_project uuid;
 v_stage crm.stage; v_current text; v_message uuid; v_booking uuid; v_amount numeric; v_event text;
 v_filter text:=coalesce(p_data->>'filter','mine'); v_search text:=coalesce(p_data->>'search','');
 v_offset int:=greatest(0,least(coalesce((p_data->>'offset')::int,0),100000));
 v_test_only boolean:=false; -- META REVIEW: ธงผู้ทดสอบ
begin
 select role into v_role from core.profile where user_id=v_actor and is_active;
 -- META REVIEW: ธง test_only มาจากแถวเดียวกับ role (ถ้าอ่านไม่ได้ = false เสมอ)
 select coalesce(test_only,false) into v_test_only from core.profile where user_id=v_actor and is_active;
 if v_actor is null or v_role is null or v_role not in ('sales','senior_sales','manager','admin') then raise exception 'not_allowed' using errcode='42501'; end if;
 -- META REVIEW: action ที่ reviewer ไม่จำเป็นต้องใช้ และไม่มีข้อมูลลูกค้าก็ตาม — ปิดตรงนี้เลย
 if v_test_only and p_action in ('report_preview','bot_status') then raise exception 'not_allowed' using errcode='42501'; end if;
 perform set_config('request.jwt.claim.sub',v_actor::text,true);
 if p_action='bootstrap' then
 return jsonb_build_object('user',jsonb_build_object('id',v_actor,'role',v_role,'email',(select email from core."user" where id=v_actor),'test_only',v_test_only),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'code',p.code,'starting_price',(select min(u.price) from inventory.unit u where u.project_id=p.id and u.status='available'))) from core.project p where status='active' and code in ('asher-naii','asher-vibe')),'[]'),
 -- META REVIEW: reviewer ไม่เห็นรายชื่อ/อีเมลทีมงาน
 'assignees',case when v_test_only then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',p.user_id,'name',u.email)) from core.profile p join core."user" u on u.id=p.user_id where p.is_active and p.role in ('sales','senior_sales','manager','admin') and (v_role in ('manager','admin') or (v_role='senior_sales' and p.team=core.current_user_team()) or p.user_id=v_actor)),'[]') end,
 'canned',coalesce((select jsonb_agg(jsonb_build_object('id',id,'shortcut',shortcut,'content',content,'project_id',project_id)) from inbox.canned_response where is_active),'[]'));
 elsif p_action='list' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into v_result from (
 select c.id,ct.display_name,ct.phone,c.status,c.assignee_id,u.email as assignee,c.last_message_at,c.last_message_preview,c.unread_count,
 i.channel,coalesce(l.project_id,i.project_id) as project_id,s.waiting_since,s.follow_up_at,s.appointment_at,st.label as stage_label,cs.case_status,cs.waiting_minutes,cs.sla_minutes,cid.external_id,ct.picture_url
 from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id join core.contact ct on ct.id=c.contact_id left join core.contact_identity cid on cid.contact_id=c.contact_id and cid.channel=i.channel and cid.account_key=c.inbox_id::text
 left join connect_private.case_state s on s.conversation_id=c.id join inbox.case_status cs on cs.conversation_id=c.id left join crm.lead l on l.id=s.lead_id left join crm.stage st on st.id=l.stage_id left join core."user" u on u.id=c.assignee_id
 where connect_private.can_read(c.id)
 -- META REVIEW: กันซ้ำกับ can_read ชั้นหนึ่ง — ให้ planner ตัดแถวได้เร็วและอ่านเจอตรง ๆ
 and (not v_test_only or c.is_test)
 and (v_search='' or position(lower(v_search) in lower(coalesce(ct.display_name,'')||' '||coalesce(ct.phone,'')))>0)
 and case v_filter when 'mine' then c.assignee_id=v_actor and c.status<>'resolved' when 'unassigned' then c.assignee_id is null and c.status<>'resolved'
 when 'waiting' then s.waiting_since is null and c.status<>'resolved' when 'sla' then s.waiting_since<=now()-interval '30 minutes' and c.status<>'resolved'
 when 'today' then (s.appointment_at at time zone 'Asia/Bangkok')::date=(now() at time zone 'Asia/Bangkok')::date and c.status<>'resolved'
 when 'followup' then s.follow_up_at<=now() and c.status<>'resolved' when 'closed' then c.status='resolved' when 'all' then c.status<>'resolved' else false end
 order by c.last_message_at desc nulls last,c.id limit 51 offset v_offset) q;
 insert into connect_private.audit(actor_id,action,detail) values(v_actor,'list',jsonb_build_object('filter',v_filter,'offset',v_offset));
 return v_result;
 elsif p_action='settings' then
 if v_role<>'admin' then raise exception 'not_allowed' using errcode='42501'; end if;
 return jsonb_build_object('channels',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'channel',channel,'active',is_active)) from inbox.inbox),'[]'));
 elsif p_action='bot_status' then
 -- ใครก็ดูได้ว่าบอทเปิดอยู่ไหม เพราะคนที่นั่งตอบต้องรู้ว่าต้องตอบเองหรือเปล่า
 return coalesce((select jsonb_agg(jsonb_build_object(
   'inbox_id',i.id,'name',i.name,'channel',i.channel,
   'generate',inbox.cfg_bool(i.id,'bot.generate_enabled',false),
   'classify',inbox.cfg_bool(i.id,'bot.classify_enabled',false),
   'live',inbox.cfg_bool(i.id,'send.live_enabled',false),
   'pending_generate',(select count(*) from connect_private.job j where j.inbox_id=i.id and j.kind='generate' and j.status='pending'),
   'pending_classify',(select count(*) from connect_private.job j where j.inbox_id=i.id and j.kind='classify' and j.status='pending'))
   order by i.name) from inbox.inbox i where i.is_active),'[]'::jsonb);
 elsif p_action='bot_switch' then
 -- เปิด/ปิดบอทเป็นเรื่องเงินและเป็นเรื่องที่ลูกค้าเห็น สงวนไว้ที่ admin เท่านั้น
 if v_role <> 'admin' then raise exception 'not_allowed' using errcode='42501'; end if;
 if coalesce(p_data->>'switch','') not in ('generate','classify') then raise exception 'invalid_request'; end if;
 insert into inbox.bot_config(inbox_id,key,value,note)
 select i.id,'bot.'||(p_data->>'switch')||'_enabled',
        to_jsonb(coalesce((p_data->>'enabled')::boolean,false)),
        'สลับจากหน้าจอเมื่อ '||to_char(now() at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI')
   from inbox.inbox i
  where i.is_active and (p_data->>'inbox_id' is null or i.id=(p_data->>'inbox_id')::uuid)
 on conflict (inbox_id,key) do update set value=excluded.value,note=excluded.note;
 insert into connect_private.audit(actor_id,action,detail) values(v_actor,'bot_switch',p_data);
 return jsonb_build_object('ok',true);
 elsif p_action='send_switch' then
 -- เปิดส่งจริง = ข้อความออกไปถึงลูกค้าจริง สงวนไว้ที่ admin เหมือนปุ่มบอท (ดู 015)
 if v_role <> 'admin' then raise exception 'not_allowed' using errcode='42501'; end if;
 insert into inbox.bot_config(inbox_id,key,value,note)
 select i.id,'send.live_enabled',to_jsonb(coalesce((p_data->>'enabled')::boolean,false)),
        'สลับจากหน้าจอเมื่อ '||to_char(now() at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI')
   from inbox.inbox i
  where i.is_active and (p_data->>'inbox_id' is null or i.id=(p_data->>'inbox_id')::uuid)
 on conflict (inbox_id,key) do update set value=excluded.value,note=excluded.note;
 insert into connect_private.audit(actor_id,action,detail) values(v_actor,'send_switch',p_data);
 return jsonb_build_object('ok',true);
 elsif p_action='setting_list' then
 if v_role not in ('manager','admin') then raise exception 'not_allowed' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('key',key,'value',value,'note',note,
   'updated_at',updated_at) order by key) from inbox.settings),'[]'::jsonb);
 elsif p_action='setting_set' then
 -- ★ ต้องตรวจค่าให้ขาดตรงนี้ ไม่ใช่ปล่อยให้ไปพังตอน cast ใน view
 --   ค่าเสียหนึ่งตัว = inbox.case_status พังทั้ง view = ทุกคนเห็นจอว่าง
 --   และจะไล่ไม่เจอว่าเกิดจากใครพิมพ์อะไรผิดเมื่อไหร่
 if v_role not in ('manager','admin') then raise exception 'not_allowed' using errcode='42501'; end if;
 v_current := coalesce(p_data->>'key','');
 if v_current not in ('sla_minutes','sla_pause_start','sla_pause_end') then raise exception 'invalid_request'; end if;
 if v_current = 'sla_minutes' then
   begin
     v_amount := (p_data->>'value')::int;
   exception when others then raise exception 'invalid_request';
   end;
   if v_amount is null or v_amount < 1 or v_amount > 1440 then raise exception 'invalid_request'; end if;
   v_result := to_jsonb(v_amount::int);
 else
   -- รับ HH:MM แล้วเก็บกลับเป็น HH:MM เสมอ จะได้ไม่มีทั้ง '6:0' และ '06:00:00' ปนกันในตาราง
   begin
     v_result := to_jsonb(to_char((p_data->>'value')::time,'HH24:MI'));
   exception when others then raise exception 'invalid_request';
   end;
 end if;
 insert into inbox.settings(key,value,updated_by) values(v_current,v_result,v_actor)
 on conflict (key) do update set value=excluded.value,updated_at=now(),updated_by=excluded.updated_by;
 insert into connect_private.audit(actor_id,action,detail) values(v_actor,'setting_set',p_data);
 return jsonb_build_object('ok',true,'key',v_current,'value',v_result);
 elsif p_action='human_reply' then
 -- Marketing OS หรือคนที่ตอบจาก chat.line.biz ยิงมาบอกว่า "คนตอบแล้ว"
 -- เป็นทางสำรองช่วงเปลี่ยนผ่านเท่านั้น ทางหลักคือเซลส์กดส่งจากหน้าจอนี้เอง
 -- ซึ่ง trigger จับได้เองอยู่แล้วโดยไม่ต้องมีใครมาบอก
 v_target := nullif(p_data->>'conversation_id','')::uuid;
 if v_target is null then
   -- ระบุด้วยช่องทาง + id ของลูกค้าก็ได้ เพราะฝั่งโน้นไม่รู้จัก conversation ของเรา
   select c.id into v_target
     from core.contact_identity ci
     join inbox.conversation c on c.contact_id = ci.contact_id
     join inbox.inbox i on i.id = c.inbox_id and i.channel = ci.channel
    where ci.channel = coalesce(p_data->>'channel','line')
      and ci.external_id = coalesce(p_data->>'external_id','')
    order by c.last_message_at desc nulls last limit 1;
 end if;
 if v_target is null then raise exception 'conversation_not_found'; end if;
 if not connect_private.can_read(v_target) then raise exception 'not_allowed' using errcode='42501'; end if;
 return connect_private.mark_human_reply(v_target,
          (select si.staff_id from inbox.sales_staff_identity si
            where si.channel = coalesce(p_data->>'channel','line')
              and si.external_id = nullif(p_data->>'staff_external_id','')),
          'api', now(), nullif(p_data->>'note',''));
 elsif p_action='report_preview' then
 -- ดูรายงานของวันไหนก็ได้โดยไม่ส่งออกไปที่ไหน — ใช้ตอนอยากเช็คก่อนส่งจริง
 -- คืนตัวเลขล้วน ๆ ส่วนการแปลงเป็นข้อความไทยอยู่ฝั่ง Node (กติกาข้อ 3)
 return jsonb_build_object('report',
   inbox.reply_report(coalesce(nullif(p_data->>'date','')::date,
                               (now() at time zone 'Asia/Bangkok')::date - 1)));
 elsif p_action='report_send' then
 -- ส่งจริงเข้าห้องของทีม จึงไม่ใช่สิทธิ์ของเซลส์ทั่วไป
 if v_role not in ('manager','admin') then raise exception 'not_allowed' using errcode='42501'; end if;
 return inbox.enqueue_daily_report(coalesce(nullif(p_data->>'date','')::date,
                                            (now() at time zone 'Asia/Bangkok')::date - 1));
 end if;
 v_id:=(p_data->>'id')::uuid;
 if not coalesce(connect_private.can_read(v_id),false) then raise exception 'conversation_not_found' using errcode='42501'; end if;
 select * into strict c from inbox.conversation where id=v_id for update;
 if p_action in ('detail','messages') then
 if p_action='detail' then
 insert into connect_private.audit(actor_id,conversation_id,action) values(v_actor,v_id,'read');
 update inbox.conversation set unread_count=0 where id=v_id;
 end if;
 select jsonb_build_object('conversation',jsonb_build_object('id',c.id,'inbox_id',c.inbox_id,'status',c.status,'assignee_id',c.assignee_id,'contact_id',c.contact_id,'bot_active',c.bot_active),
 'contact',(select jsonb_build_object('display_name',ct2.display_name,'phone',ct2.phone,'picture_url',ct2.picture_url,'external_id',(select ci2.external_id from core.contact_identity ci2 where ci2.contact_id=ct2.id and ci2.channel=(select channel from inbox.inbox where id=c.inbox_id) and ci2.account_key=c.inbox_id::text limit 1)) from core.contact ct2 where ct2.id=c.contact_id),
 'state',(select to_jsonb(s) from connect_private.case_state s where conversation_id=v_id),
 'case_status',(select to_jsonb(cs) from inbox.case_status cs where cs.conversation_id=v_id),
 'lead',(select to_jsonb(l)||jsonb_build_object('stage_code',st.code) from connect_private.case_state s join crm.lead l on l.id=s.lead_id join crm.stage st on st.id=l.stage_id where s.conversation_id=v_id),
 'channel',(select channel from inbox.inbox where id=c.inbox_id),
 'last_agent_reply',(select jsonb_build_object('name',coalesce(ss2.name,su2.email),'by',msg.sender_id,'at',msg.created_at)
   from inbox.message msg
   left join inbox.sales_staff ss2 on ss2.user_id=msg.sender_id
   left join core."user" su2 on su2.id=msg.sender_id
  where msg.conversation_id=v_id and msg.sender_type='agent'
  order by msg.created_at desc,msg.id desc limit 1),
 'units',coalesce((select jsonb_agg(jsonb_build_object('id',id,'number',number,'price',price)) from inventory.unit where project_id=(select project_id from crm.lead where id=(select lead_id from connect_private.case_state where conversation_id=v_id)) and status='available'),'[]'),
 'messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at,m.id) from (select m.id,m.sender_type,m.content,m.content_type,m.created_at,m.delivered_at,d.status as delivery_status,d.last_error,m.sender_id,coalesce(ss.name,su.email) as sender_name from inbox.message m left join connect_private.delivery d on d.message_id=m.id left join inbox.sales_staff ss on ss.user_id=m.sender_id left join core."user" su on su.id=m.sender_id where m.conversation_id=v_id and (p_data->>'before' is null or m.created_at<(p_data->>'before')::timestamptz) order by m.created_at desc,m.id desc limit 100) m),'[]')) into v_result;
 return v_result;
 end if;
 v_request:=(p_data->>'request_id')::uuid;
 if v_request is null then raise exception 'request_id_required'; end if;
 select * into v_old from connect_private.command where request_id=v_request;
 if found then
 if v_old.actor_id<>v_actor or v_old.action<>p_action or v_old.conversation_id<>v_id or v_old.input<>p_data then raise exception 'request_id_conflict'; end if;
 return v_old.result;
 end if;
 if p_action='claim' then
 if c.assignee_id is not null and c.assignee_id<>v_actor then raise exception 'already_assigned'; end if;
 if c.status='resolved' then raise exception 'case_closed'; end if;
 update inbox.conversation set assignee_id=v_actor,status='open',bot_active=false where id=v_id;
 v_lead:=connect_private.ensure_lead(v_id);
 update crm.lead set owner_id=v_actor where id=v_lead;
 v_event:='lead_assigned';
 else
 -- ★ ตอบลูกค้าได้โดยไม่ต้องรับเคสก่อน — ทีมเซลส์ใช้คิวรวม ไม่มีเจ้าของเคสรายคน
 -- สิทธิ์ยังถูกตรวจอยู่ ไม่ได้เปิดกว้าง: หัวฟังก์ชันคัดมาแล้วว่าต้องเป็น
 -- sales / senior_sales / manager / admin ที่ is_active เท่านั้นถึงจะมาถึงบรรทัดนี้
 -- และ connect_private.can_read() ยังคุมว่าเห็นเคสไหนได้บ้างตามเดิม
 --
 -- ★ ยกเว้นเฉพาะ send กับ retry ไม่ใช่ทุก action — งานที่แก้ข้อมูลลูกค้าหรือ
 --   เลื่อนสถานะดีล (save/stage/appointment/close/follow_up) ยังต้องรับเคสก่อน
 --   เพราะสองอย่างนั้นคนละเรื่องกัน: ตอบแชทคืองานคิวรวม แต่เจ้าของดีลต้องมีคนเดียว
 if p_action not in ('send','retry')
    and (c.assignee_id is null
         or (c.assignee_id<>v_actor and v_role not in ('manager','admin')
             and not (v_role='senior_sales' and p_action='transfer')))
 then raise exception 'claim_required' using errcode='42501'; end if;
 select s.lead_id into v_lead from connect_private.case_state s where s.conversation_id=v_id;
 if v_lead is null then v_lead:=connect_private.ensure_lead(v_id); end if;
 select * into strict l from crm.lead where id=v_lead for update;
 if c.status='resolved' then raise exception 'case_closed'; end if;
 if p_action='transfer' then
 if v_role not in ('manager','admin','senior_sales') then raise exception 'not_allowed' using errcode='42501'; end if;
 v_target:=(p_data->>'assignee_id')::uuid;
 if not exists(select 1 from core.profile where user_id=v_target and is_active and role in ('sales','senior_sales','manager','admin') and (v_role in ('manager','admin') or team=core.current_user_team())) then raise exception 'assignee_not_allowed'; end if;
 update inbox.conversation set assignee_id=v_target,bot_active=false where id=v_id;
 update crm.lead set owner_id=v_target where id=v_lead;
 v_event:='lead_assigned';
 elsif p_action='save' then
 if coalesce((p_data->>'version')::int,-1)<>(select version from connect_private.case_state where conversation_id=v_id) then raise exception 'version_conflict'; end if;
 v_project:=(p_data->>'project_id')::uuid;
 if v_project is null then raise exception 'project_required'; end if;
 if v_project<>l.project_id then
 if (select code from crm.stage where id=l.stage_id) in ('booking','sale') then raise exception 'booked_project_locked'; end if;
 v_lead:=connect_private.ensure_lead(v_id,v_project);
 end if;
 if length(coalesce(p_data->>'display_name',''))>200 or length(coalesce(p_data->>'phone',''))>40 or length(coalesce(p_data->>'room',''))>100 then raise exception 'invalid_profile'; end if;
 if nullif(p_data->>'budget','')::numeric<0 or nullif(p_data->>'budget','')::numeric>999999999999 then raise exception 'invalid_budget'; end if;
 if coalesce(p_data->>'interest','') not in ('high','medium','low','unknown') then raise exception 'invalid_interest'; end if;
 update core.contact set display_name=nullif(p_data->>'display_name',''),phone=nullif(p_data->>'phone',''),
   extra = case when nullif(btrim(p_data->>'display_name'),'') is not null
                then extra || jsonb_build_object('name_source','manual','name_set_at',to_jsonb(now()))
                else extra - 'name_source' - 'name_set_at' end
 where id=c.contact_id;
 update crm.lead set budget=nullif(p_data->>'budget','')::numeric,interest_unit_type=p_data->>'room',extra=extra||jsonb_build_object('interest',p_data->>'interest') where id=v_lead;
 update connect_private.case_state set follow_up_at=nullif(p_data->>'follow_up_at','')::timestamptz where conversation_id=v_id;
 update crm.activity set done_at=now() where conversation_id=v_id and type='task' and done_at is null and extra->>'source'='connect_followup';
 if nullif(p_data->>'follow_up_at','') is not null then
 insert into crm.activity(lead_id,type,due_at,owner_id,conversation_id,body,extra) values(v_lead,'task',(p_data->>'follow_up_at')::timestamptz,c.assignee_id,v_id,'ติดตามลูกค้า','{"source":"connect_followup"}');
 end if;
 v_event:='lead_profile_updated';
 elsif p_action='send' then
 if length(trim(coalesce(p_data->>'text','')))=0 or length(p_data->>'text')>2000 then raise exception 'invalid_message'; end if;
 if exists(select 1 from inbox.inbox where id=c.inbox_id and not is_active) then raise exception 'channel_disabled'; end if;
 insert into inbox.message(conversation_id,sender_type,sender_id,content) values(v_id,'agent',v_actor,trim(p_data->>'text')) returning id into v_message;
 -- คิวขาออกเป็นของ trigger inbox.enqueue_outbound เท่านั้น (ดูหัวไฟล์ migration)
 update inbox.conversation set bot_active=false where id=v_id;
 v_event:='message_queued';
 elsif p_action='retry' then
 v_message:=(p_data->>'message_id')::uuid;
 if not exists(select 1 from inbox.message where id=v_message and conversation_id=v_id) then raise exception 'message_not_found'; end if;
 update connect_private.delivery set status='pending',available_at=now(),last_error=null,attempts=0 where message_id=v_message and status='failed';
 if not found then raise exception 'message_not_retryable'; end if;
 v_event:='message_retry_requested';
 elsif p_action in ('stage','appointment','close') then
 select code into v_current from crm.stage where id=l.stage_id;
 select * into v_stage from crm.stage where pipeline_id=l.pipeline_id and code=case p_action when 'appointment' then 'appointment' when 'close' then 'lost' else p_data->>'stage' end;
 if not found then raise exception 'invalid_stage'; end if;
 if p_action='close' and length(trim(coalesce(p_data->>'reason','')))=0 then raise exception 'reason_required'; end if;
 if v_stage.code='appointment' then
 if nullif(p_data->>'appointment_at','') is null or (p_data->>'appointment_at')::timestamptz<now() then raise exception 'future_appointment_required'; end if;
 update connect_private.case_state set appointment_at=(p_data->>'appointment_at')::timestamptz where conversation_id=v_id;
 insert into crm.activity(lead_id,type,due_at,owner_id,conversation_id,body) values(v_lead,'site_visit',(p_data->>'appointment_at')::timestamptz,c.assignee_id,v_id,'นัดเข้าชมโครงการ');
 elsif v_stage.code='walk_in' then
 insert into crm.activity(lead_id,type,done_at,owner_id,conversation_id,body) values(v_lead,'site_visit',now(),c.assignee_id,v_id,'ลูกค้ามาถึงโครงการ');
 elsif v_stage.code='booking' then
 if v_current<>'walk_in' then raise exception 'walk_in_required'; end if;
 v_amount:=(p_data->>'amount')::numeric;
 if v_amount is null or v_amount<=0 or coalesce((p_data->>'deposit')::numeric,-1)<0 or (p_data->>'deposit')::numeric>v_amount then raise exception 'invalid_amount'; end if;
 if not exists(select 1 from inventory.unit where id=(p_data->>'unit_id')::uuid and project_id=l.project_id and status='available') then raise exception 'unit_unavailable'; end if;
 insert into doc.booking(project_id,unit_id,lead_id,contact_id,unit_price,net_amount,deposit,created_by)
 values(l.project_id,(p_data->>'unit_id')::uuid,v_lead,c.contact_id,v_amount,v_amount,(p_data->>'deposit')::numeric,v_actor) returning id into v_booking;
 perform doc.post_booking(v_booking,v_actor,v_request::text);
 elsif v_stage.code='sale' then
 if length(trim(coalesce(p_data->>'reference','')))=0 then raise exception 'sale_reference_required'; end if;
 select id into v_booking from doc.booking where lead_id=v_lead and status='posted' order by created_at desc limit 1;
 if v_booking is null then raise exception 'booking_required'; end if;
 update crm.lead set extra=extra||jsonb_build_object('sale_reference',p_data->>'reference','booking_id',v_booking) where id=v_lead;
 end if;
 if v_current<>v_stage.code then perform crm.move_stage_guarded(v_lead,v_stage.id,v_actor,v_request::text); end if;
 if p_action='close' then
 update crm.lead set lost_reason=left(p_data->>'reason',2000) where id=v_lead;
 update inbox.conversation set status='resolved',bot_active=false where id=v_id;
 end if;
 v_event:=case v_stage.code when 'qualified' then 'lead_qualified' when 'appointment' then 'appointment_created' when 'walk_in' then 'walk_in_recorded' when 'booking' then 'booking_created' when 'sale' then 'sale_completed' when 'lost' then 'lead_closed' else 'follow_up_scheduled' end;
 else raise exception 'unknown_action'; end if;
 end if;
 update connect_private.case_state set version=version+1 where conversation_id=v_id;
 v_result:=jsonb_build_object('ok',true,'message_id',v_message,'booking_id',v_booking,'lead_id',v_lead);
 perform connect_private.emit(v_id,v_event,(p_data-'text')||v_result);
 insert into connect_private.audit(actor_id,conversation_id,action,detail) values(v_actor,v_id,p_action,(p_data-'text')||v_result);
 insert into connect_private.command values(v_request,v_actor,p_action,v_id,p_data,v_result,now());
 return v_result;
end $function$;
