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

 elsif p_action='health' then
 return jsonb_build_object(
   'pending',(select count(*) from connect_private.delivery where status in ('pending','processing')),
   'failed',(select count(*) from connect_private.delivery where status in ('failed','uncertain')),
   'inbound_pending',(select count(*) from connect_private.webhook_log where status in ('pending','processing')),
   'inbound_failed',(select count(*) from connect_private.webhook_log where status='failed'));
 end if;
 raise exception 'unknown_action';
end $function$

