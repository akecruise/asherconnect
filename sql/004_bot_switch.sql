-- ═══════════════════════════════════════════════════════════════════════════
-- ปุ่มเปิด/ปิดบอท — อยู่ในฐาน กดจากหน้าจอได้ ไม่ต้องแก้ไฟล์แล้วรีสตาร์ต
--
-- ทำไมไม่ใช้ env: env เปลี่ยนทีต้อง recreate container ซึ่งแปลว่า "ปิดบอทด่วน"
-- ต้องรอ deploy — ช้าเกินไปสำหรับเรื่องที่เสียเงินทุกข้อความ
--
-- ทำไมไม่ใช้ reply.enabled ที่มีอยู่แล้ว: ตัวนั้นเป็น *กฎธุรกิจ*
-- ปิดแล้ว decide_reply จะตอบว่า reply_disabled ซึ่งทำให้ bot_decisions ไม่ตรงกับ cloud
-- แล้วการเทียบผลตอน shadow 3 วันจะใช้ไม่ได้ทันที
--
-- ตัวนี้จึงเป็นสวิตช์ของ *การลงมือทำ* ไม่ใช่ของการตัดสินใจ
--   receive() ยังตัดสินใจและบันทึก bot_decisions ตามปกติทุกข้อความ
--   งานยังเข้าคิวครบ ไม่หายไปไหน
--   worker แค่ไม่หยิบมันมาทำ → ไม่เรียก Claude → ไม่เสียเงิน
--   เปิดวันไหนก็เดินต่อจากของที่ค้างไว้
--
-- ค่าเริ่มต้นคือ "ปิด" ทั้งสองตัว — ของที่เสียเงินต้องเปิดเอง ไม่ใช่ติดมาเอง
-- และงานที่ค้างเพราะถูกปิดถูกนับไว้ให้เห็นทั้งใน /health และบนหน้าจอ
-- เพราะ "ปิดอยู่" กับ "พัง" ต้องแยกออกจากกันได้เสมอ
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1) ค่าเริ่มต้นของสวิตช์: ปิด
insert into inbox.bot_config(inbox_id,key,value,note)
select i.id,'bot.generate_enabled','false'::jsonb,'ปุ่มเปิด/ปิดการคิดคำตอบ — เปิดแล้วเรียก Claude ทุกข้อความ'
  from inbox.inbox i
on conflict (inbox_id,key) do nothing;

insert into inbox.bot_config(inbox_id,key,value,note)
select i.id,'bot.classify_enabled','false'::jsonb,'ปุ่มเปิด/ปิดการถอดหมวดคำถาม — เรียก Claude เหมือนกัน'
  from inbox.inbox i
on conflict (inbox_id,key) do nothing;

-- inbox ที่สร้างทีหลังต้องได้ค่าเริ่มต้นนี้ด้วย
create or replace function inbox.seed_bot_switches(p_inbox uuid)
returns void language sql
set search_path = pg_catalog, public
as $fn$
  insert into inbox.bot_config(inbox_id,key,value,note) values
    (p_inbox,'bot.generate_enabled','false'::jsonb,'ปุ่มเปิด/ปิดการคิดคำตอบ'),
    (p_inbox,'bot.classify_enabled','false'::jsonb,'ปุ่มเปิด/ปิดการถอดหมวดคำถาม')
  on conflict (inbox_id,key) do nothing
$fn$;

-- ── 2) ด่านจริงอยู่ตรงนี้: ปิดอยู่ = ไม่ถูกหยิบมาเลย
--     ไม่ใช่หยิบมาแล้วค่อยเช็ค ซึ่งจะทำให้ attempts เดินและลำดับเสีย
create or replace function connect_private.claim_job(p_kinds text[], p_inbox_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare v_result jsonb;
begin
  update connect_private.job set status='pending', lease_id=null
   where status='processing' and locked_at < now() - interval '2 minutes';

  with picked as (
    select j.id from connect_private.job j
     where j.status='pending' and j.send_after <= now()
       and j.kind = any(p_kinds)
       and (p_inbox_ids is null or j.inbox_id = any(p_inbox_ids))
       -- งานที่เรียก Claude ต้องมีสวิตช์ของ inbox นั้นเปิดอยู่
       and (j.kind not in ('generate','classify')
            or inbox.cfg_bool(j.inbox_id, 'bot.' || j.kind || '_enabled', false))
     order by j.send_after, j.id
     limit 1 for update skip locked
  ), updated as (
    update connect_private.job j
       set status='processing', attempts=attempts+1, locked_at=now(), lease_id=gen_random_uuid()
      from picked p where j.id=p.id returning j.*
  )
  select to_jsonb(u) || jsonb_build_object(
           'channel_of_inbox',(select i.channel from inbox.inbox i where i.id=u.inbox_id))
    into v_result from updated u;
  return v_result;
end $fn$;

-- ── 3) ภาพรวมให้ /health ดู: ค้างเท่าไร และสวิตช์อยู่ท่าไหน
create or replace function connect_private.job_counts()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $fn$
  select jsonb_build_object(
    'pending', coalesce((select jsonb_object_agg(kind,n) from
                 (select kind,count(*) as n from connect_private.job where status='pending' group by kind) s),'{}'::jsonb),
    'switches', coalesce((select jsonb_agg(jsonb_build_object(
                   'name',i.name,
                   'generate',inbox.cfg_bool(i.id,'bot.generate_enabled',false),
                   'classify',inbox.cfg_bool(i.id,'bot.classify_enabled',false),
                   'pending_generate',(select count(*) from connect_private.job j
                                        where j.inbox_id=i.id and j.kind='generate' and j.status='pending'))
                   order by i.name) from inbox.inbox i where i.is_active),'[]'::jsonb))
$fn$;

revoke all on function connect_private.job_counts() from public, anon, authenticated;
grant execute on function connect_private.job_counts() to service_role;
revoke all on function inbox.seed_bot_switches(uuid) from public, anon, authenticated;
grant execute on function inbox.seed_bot_switches(uuid) to service_role;

-- ── 4) worker: เพิ่ม action job_counts
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

 elsif p_action='job_counts' then
 return connect_private.job_counts();

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

-- ── 5) connect_api: อ่านสถานะ และสลับสวิตช์ (ผู้จัดการขึ้นไป)
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
begin
 select role into v_role from core.profile where user_id=v_actor and is_active;
 if v_actor is null or v_role is null or v_role not in ('sales','senior_sales','manager','admin') then raise exception 'not_allowed' using errcode='42501'; end if;
 perform set_config('request.jwt.claim.sub',v_actor::text,true);
 if p_action='bootstrap' then
 return jsonb_build_object('user',jsonb_build_object('id',v_actor,'role',v_role,'email',(select email from core."user" where id=v_actor)),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'code',p.code)) from core.project p where status='active' and code in ('asher-naii','asher-vibe')),'[]'),
 'assignees',coalesce((select jsonb_agg(jsonb_build_object('id',p.user_id,'name',u.email)) from core.profile p join core."user" u on u.id=p.user_id where p.is_active and p.role in ('sales','senior_sales','manager','admin') and (v_role in ('manager','admin') or (v_role='senior_sales' and p.team=core.current_user_team()) or p.user_id=v_actor)),'[]'),
 'canned',coalesce((select jsonb_agg(jsonb_build_object('id',id,'shortcut',shortcut,'content',content,'project_id',project_id)) from inbox.canned_response where is_active),'[]'));
 elsif p_action='list' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into v_result from (
 select c.id,ct.display_name,ct.phone,c.status,c.assignee_id,u.email as assignee,c.last_message_at,c.last_message_preview,c.unread_count,
 i.channel,coalesce(l.project_id,i.project_id) as project_id,s.waiting_since,s.follow_up_at,s.appointment_at,st.label as stage_label
 from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id join core.contact ct on ct.id=c.contact_id
 left join connect_private.case_state s on s.conversation_id=c.id left join crm.lead l on l.id=s.lead_id left join crm.stage st on st.id=l.stage_id left join core."user" u on u.id=c.assignee_id
 where connect_private.can_read(c.id) and (v_search='' or position(lower(v_search) in lower(coalesce(ct.display_name,'')||' '||coalesce(ct.phone,'')))>0)
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
   'pending_generate',(select count(*) from connect_private.job j where j.inbox_id=i.id and j.kind='generate' and j.status='pending'),
   'pending_classify',(select count(*) from connect_private.job j where j.inbox_id=i.id and j.kind='classify' and j.status='pending'))
   order by i.name) from inbox.inbox i where i.is_active),'[]'::jsonb);

 elsif p_action='bot_switch' then
 -- เปิด/ปิดบอทเป็นเรื่องเงินและเป็นเรื่องที่ลูกค้าเห็น จึงไม่ใช่สิทธิ์ของเซลส์ทั่วไป
 if v_role not in ('manager','admin') then raise exception 'not_allowed' using errcode='42501'; end if;
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
 'contact',(select jsonb_build_object('display_name',display_name,'phone',phone) from core.contact where id=c.contact_id),
 'state',(select to_jsonb(s) from connect_private.case_state s where conversation_id=v_id),
 'lead',(select to_jsonb(l)||jsonb_build_object('stage_code',st.code) from connect_private.case_state s join crm.lead l on l.id=s.lead_id join crm.stage st on st.id=l.stage_id where s.conversation_id=v_id),
 'channel',(select channel from inbox.inbox where id=c.inbox_id),
 'units',coalesce((select jsonb_agg(jsonb_build_object('id',id,'number',number,'price',price)) from inventory.unit where project_id=(select project_id from crm.lead where id=(select lead_id from connect_private.case_state where conversation_id=v_id)) and status='available'),'[]'),
 'messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at,m.id) from (select m.id,m.sender_type,m.content,m.content_type,m.created_at,m.delivered_at,d.status as delivery_status,d.last_error from inbox.message m left join connect_private.delivery d on d.message_id=m.id where m.conversation_id=v_id and (p_data->>'before' is null or m.created_at<(p_data->>'before')::timestamptz) order by m.created_at desc,m.id desc limit 100) m),'[]')) into v_result;
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
 if c.assignee_id is null or (c.assignee_id<>v_actor and v_role not in ('manager','admin') and not (v_role='senior_sales' and p_action='transfer')) then raise exception 'claim_required' using errcode='42501'; end if;
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
 update core.contact set display_name=nullif(p_data->>'display_name',''),phone=nullif(p_data->>'phone','') where id=c.contact_id;
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

revoke all on function connect_private.api(text,jsonb) from public,anon;
grant execute on function connect_private.api(text,jsonb) to authenticated,service_role;

commit;
