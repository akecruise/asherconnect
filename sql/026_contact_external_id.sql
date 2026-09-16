-- 026_contact_external_id.sql
--
-- ส่ง external_id (PSID ของ Facebook / userId ของ LINE) ออกมาให้หน้าจอ
-- เพื่อให้แสดงแทนชื่อได้ตอนที่ลูกค้ายังไม่มีชื่อ
--
-- ทำไมต้องส่งมาจากฐาน ไม่ให้หน้าจอไปหาเอง:
-- external_id อยู่ใน core.contact_identity ซึ่งหน้าจออ่านตรงไม่ได้ (RLS + ไม่มีทางเรียก)
-- และการจับคู่ต้องใช้คีย์สามชั้น (channel, account_key, external_id) ที่ตรงกับ
-- core.resolve_identity() เป๊ะ ๆ ถ้าให้ที่อื่นประกอบคีย์เองจะเพี้ยนเงียบ ๆ วันใดวันหนึ่ง
--
-- ★ account_key คือ "uuid ของ inbox" ไม่ใช่ channel key — ดู core.resolve_identity():
--     core.resolve_identity(v_inbox.channel, external_id, v_inbox.id::text, ...)
--   join ผิดคีย์จะได้ NULL เงียบ ๆ ไม่ error
--
-- ★ คัดจาก pg_get_functiondef() ของจริงบน VPS เมื่อ 2026-09-15 (หลัง 025)
--   เหตุผลเดียวกับที่ 015 เตือน — สร้างใหม่จากไฟล์เก่าจะทำให้ของที่ลงไปแล้วหายเงียบ ๆ
--
-- ที่เพิ่มมีสองจุด:
--   1. list   + cid.external_id (left join core.contact_identity)
--   2. detail + contact.external_id
--
-- กฎการ "เลือกจะโชว์อะไร" อยู่ที่หน้าจอ (public/app.js · customerName())
-- ฐานแค่ส่งวัตถุดิบมาให้ครบ
--
-- ย้อนกลับ: รัน sql/025_reply_without_claim.sql ซ้ำ

begin;

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
 i.channel,coalesce(l.project_id,i.project_id) as project_id,s.waiting_since,s.follow_up_at,s.appointment_at,st.label as stage_label,cs.case_status,cs.waiting_minutes,cs.sla_minutes,cid.external_id
 from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id join core.contact ct on ct.id=c.contact_id left join core.contact_identity cid on cid.contact_id=c.contact_id and cid.channel=i.channel and cid.account_key=c.inbox_id::text
 left join connect_private.case_state s on s.conversation_id=c.id join inbox.case_status cs on cs.conversation_id=c.id left join crm.lead l on l.id=s.lead_id left join crm.stage st on st.id=l.stage_id left join core."user" u on u.id=c.assignee_id
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
 'contact',(select jsonb_build_object('display_name',ct2.display_name,'phone',ct2.phone,'external_id',(select ci2.external_id from core.contact_identity ci2 where ci2.contact_id=ct2.id and ci2.channel=(select channel from inbox.inbox where id=c.inbox_id) and ci2.account_key=c.inbox_id::text limit 1)) from core.contact ct2 where ct2.id=c.contact_id),
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
end $function$

;

commit;
