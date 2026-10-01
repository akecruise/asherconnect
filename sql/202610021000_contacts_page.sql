-- =====================================================================
-- 202610021000_contacts_page.sql — หน้า "รายชื่อติดต่อ" + drawer ลูกค้า (สไตล์ LINE OA Manager)
-- =====================================================================
-- ★ อ่านอย่างเดียว: ไม่มีตาราง ไม่มี update/insert ข้อมูล ไม่แตะเวลาของข้อความ
--   (inbox.message.created_at คือนาฬิกา SLA — ห้ามแตะเด็ดขาด)
-- ★ ไม่แตะ connect_private.api · ด่านสิทธิ์ = connect_private.can_read ตัวเดียวกับกิ่ง list
-- ★ ต้องลงหลัง 202610011000_contact_star_tags.sql (ใช้ inbox.flag_actor / flag_tags_of / flag_contact_of)
--
-- ป้าย SLA ไม่คำนวณใหม่ — อ่านจาก inbox.case_status (sql/202609251000_customer_reply_monitor.sql)
-- ซึ่งนับจากข้อความลูกค้าจริงเทียบกับคำตอบของคนที่ส่งถึงจริง (reply_message_delivered / last_human_reply_at)
-- ไม่เดาว่าพนักงานตอบแล้ว · เกณฑ์ "ใกล้เกิน" = ครึ่งหนึ่งของ sla_minutes ตรงกับ public/sla.mjs (5/10)
--
-- ระยะ (lifecycle) มาจากหลักฐาน ไม่ใช่ป้ายที่คนตั้งเอง:
--   crm.stage ของ lead ล่าสุด  appointment/walk_in → นัดชม · booking → จอง · sale → ปิดการขาย · lost → หลุด
--   ที่เหลือ (ไม่มี lead / follow_up / qualified):
--     ยังไม่มีคนตอบเลย (last_human_reply_at และ first_human_response_at ว่าง) → ใหม่ · ไม่งั้น → กำลังคุย
--
-- เบอร์โทร: manager/admin เห็นเต็ม · role อื่นได้ ***-***-1234 (ตัดที่ฐาน ไม่ส่งเบอร์เต็มออกไปเลย)
--   ★ รอผู้ใช้ยืนยันว่า role ไหนเห็นเต็ม — ตอนนี้เลือกแบบแคบสุดไว้ก่อน แก้ที่ inbox.contact_phone_out ที่เดียว
--
-- รันซ้ำได้ (create or replace ทั้งไฟล์)

begin;

-- ── ตัวช่วย ──────────────────────────────────────────────────────────
create or replace function inbox.contact_phone_out(p_phone text, p_actor jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when nullif(btrim(coalesce(p_phone, '')), '') is null then null
    when p_actor->>'role' in ('manager','admin') and not coalesce((p_actor->>'test_only')::boolean, false) then p_phone
    when length(regexp_replace(p_phone, '\D', '', 'g')) < 4 then '***'
    else '***-***-' || right(regexp_replace(p_phone, '\D', '', 'g'), 4) end
$$;

create or replace function inbox.contact_stage(p_stage_code text, p_last_human_reply_at timestamptz, p_first_human_response_at timestamptz)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_stage_code in ('appointment','walk_in') then 'appointment'
    when p_stage_code = 'booking' then 'booking'
    when p_stage_code = 'sale' then 'sale'
    when p_stage_code = 'lost' then 'lost'
    when p_last_human_reply_at is null and p_first_human_response_at is null then 'new'
    else 'talking' end
$$;

-- over = เกิน SLA · near = ตั้งแต่ครึ่งหนึ่งของ SLA · ok = ไม่มีใครรอ/ยังไม่ถึงครึ่ง
create or replace function inbox.contact_sla(p_case_status text, p_waiting int, p_sla int)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_case_status = 'late' then 'over'
    when p_case_status = 'new' and p_waiting is not null and p_sla is not null and p_waiting * 2 >= p_sla then 'near'
    else 'ok' end
$$;

-- ── contacts_list: ลูกค้าหนึ่งคนหนึ่งแถว รวมทุกช่องทาง ──────────────────
-- p = {search, tag_id, stage, assignee ('none'|uuid), channel, sla ('over'|'near'|'ok'), starred, sort ('desc'|'asc'), offset}
-- แถวอิงบทสนทนาล่าสุดที่คนเรียกมองเห็นได้ (can_read) ของลูกค้าคนนั้น
create or replace function inbox.contacts_list(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_test_only boolean; v_result jsonb;
        v_search text := btrim(coalesce(p->>'search', ''));
        v_tag uuid := nullif(p->>'tag_id', '')::uuid;
        v_stage text := nullif(p->>'stage', '');
        v_assignee text := nullif(p->>'assignee', '');
        v_channel text := nullif(p->>'channel', '');
        v_sla text := nullif(p->>'sla', '');
        v_starred boolean := coalesce((p->>'starred')::boolean, false);
        v_asc boolean := coalesce(p->>'sort', '') = 'asc';
        v_offset int := greatest(0, least(coalesce(nullif(p->>'offset', '')::int, 0), 100000));
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  if v_stage is not null and v_stage not in ('new','talking','appointment','booking','sale','lost') then raise exception 'invalid_filter'; end if;
  if v_sla is not null and v_sla not in ('over','near','ok') then raise exception 'invalid_filter'; end if;
  if v_assignee is not null and v_assignee <> 'none' then perform v_assignee::uuid; end if;
  v_test_only := (v_actor->>'test_only')::boolean;

  with seen as (
    select c.id, c.contact_id, c.assignee_id, c.status, c.last_message_at, c.last_message_preview,
           c.last_human_reply_at, i.channel
      from inbox.conversation c join inbox.inbox i on i.id = c.inbox_id
     where connect_private.can_read(c.id) and (not v_test_only or c.is_test)
  ), per_contact as (
    select s.contact_id,
           (array_agg(s.id order by s.last_message_at desc nulls last, s.id))[1] as conversation_id,
           array_agg(distinct s.channel) as channels,
           max(s.last_message_at) as last_message_at
      from seen s group by s.contact_id
  ), rows as (
    select pc.contact_id, pc.conversation_id, pc.channels, pc.last_message_at,
           ct.display_name, ct.phone, ct.picture_url,
           c.assignee_id, c.last_message_preview, c.status,
           coalesce(ss.name, u.email) as assignee_name,
           inbox.contact_stage(st.code, c.last_human_reply_at, cs0.first_human_response_at) as stage,
           inbox.contact_sla(cs.case_status, cs.waiting_minutes, cs.sla_minutes) as sla,
           cs.waiting_minutes, cs.sla_minutes,
           coalesce(f.starred, false) as starred,
           cs0.follow_up_at
      from per_contact pc
      join core.contact ct on ct.id = pc.contact_id
      join inbox.conversation c on c.id = pc.conversation_id
      left join inbox.case_status cs on cs.conversation_id = c.id
      left join connect_private.case_state cs0 on cs0.conversation_id = c.id
      left join crm.lead l on l.id = cs0.lead_id
      left join crm.stage st on st.id = l.stage_id
      left join core."user" u on u.id = c.assignee_id
      left join inbox.sales_staff ss on ss.user_id = c.assignee_id
      left join connect_private.contact_flag f on f.contact_id = pc.contact_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'contact_id', r.contact_id, 'conversation_id', r.conversation_id,
           'display_name', r.display_name, 'picture_url', r.picture_url,
           'phone', inbox.contact_phone_out(r.phone, v_actor),
           'channels', to_jsonb(r.channels), 'last_message_at', r.last_message_at,
           'last_message_preview', r.last_message_preview, 'status', r.status,
           'assignee_id', r.assignee_id, 'assignee_name', r.assignee_name,
           'stage', r.stage, 'sla', r.sla, 'waiting_minutes', r.waiting_minutes, 'sla_minutes', r.sla_minutes,
           'starred', r.starred, 'follow_up_at', r.follow_up_at,
           'tags', inbox.flag_tags_of(r.contact_id))
         order by case when v_asc then r.last_message_at end asc nulls last,
                  case when not v_asc then r.last_message_at end desc nulls last, r.contact_id), '[]'::jsonb)
    into v_result
    from (select * from rows r
           where (v_search = '' or position(lower(v_search) in
                   lower(coalesce(r.display_name, '') || ' ' || coalesce(r.phone, ''))) > 0)
             and (v_tag is null or exists (select 1 from connect_private.contact_tag x
                                             join connect_private.tag t on t.id = x.tag_id and t.is_active
                                            where x.contact_id = r.contact_id and x.tag_id = v_tag))
             and (v_stage is null or r.stage = v_stage)
             and (v_assignee is null or (v_assignee = 'none' and r.assignee_id is null)
                  or (v_assignee <> 'none' and r.assignee_id = v_assignee::uuid))
             and (v_channel is null or v_channel = any(r.channels))
             and (v_sla is null or r.sla = v_sla)
             and (not v_starred or r.starred)
           order by case when v_asc then r.last_message_at end asc nulls last,
                    case when not v_asc then r.last_message_at end desc nulls last, r.contact_id
           limit 51 offset v_offset) r;

  insert into connect_private.audit(actor_id, action, detail)
  values (auth.uid(), 'list', jsonb_build_object('page', 'contacts', 'filter', p - 'search', 'offset', v_offset));
  return v_result;
end $$;

-- ── contact_detail: drawer ลูกค้า (ประวัติย่อ) ───────────────────────────
-- p = {conversation_id} → ลูกค้าของเคสนั้น + ทุกบทสนทนาของลูกค้าที่มองเห็นได้
create or replace function inbox.contact_detail(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_contact uuid; v_test_only boolean; v_result jsonb;
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  v_contact := inbox.flag_contact_of(nullif(p->>'conversation_id', '')::uuid);
  v_test_only := (v_actor->>'test_only')::boolean;
  select jsonb_build_object(
    'contact_id', ct.id, 'display_name', ct.display_name, 'picture_url', ct.picture_url,
    'phone', inbox.contact_phone_out(ct.phone, v_actor),
    'phone_masked', not (v_actor->>'role' in ('manager','admin') and not v_test_only),
    'starred', coalesce(f.starred, false), 'follow_note', f.follow_note,
    'tags', inbox.flag_tags_of(ct.id),
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'channel', i.channel, 'status', c.status,
               'last_message_at', c.last_message_at, 'last_message_preview', c.last_message_preview,
               'assignee_id', c.assignee_id, 'assignee_name', coalesce(ss.name, u.email),
               'stage', inbox.contact_stage(st.code, c.last_human_reply_at, s.first_human_response_at),
               'sla', inbox.contact_sla(cs.case_status, cs.waiting_minutes, cs.sla_minutes),
               'waiting_minutes', cs.waiting_minutes, 'follow_up_at', s.follow_up_at,
               'appointment_at', s.appointment_at, 'last_human_reply_at', c.last_human_reply_at)
             order by c.last_message_at desc nulls last, c.id)
        from inbox.conversation c
        join inbox.inbox i on i.id = c.inbox_id
        left join inbox.case_status cs on cs.conversation_id = c.id
        left join connect_private.case_state s on s.conversation_id = c.id
        left join crm.lead l on l.id = s.lead_id
        left join crm.stage st on st.id = l.stage_id
        left join core."user" u on u.id = c.assignee_id
        left join inbox.sales_staff ss on ss.user_id = c.assignee_id
       where c.contact_id = ct.id and connect_private.can_read(c.id) and (not v_test_only or c.is_test)), '[]'::jsonb))
    into v_result
    from core.contact ct
    left join connect_private.contact_flag f on f.contact_id = ct.id
   where ct.id = v_contact;
  return v_result;
end $$;

-- ── สิทธิ์ ───────────────────────────────────────────────────────────
revoke all on function inbox.contact_phone_out(text, jsonb), inbox.contact_stage(text, timestamptz, timestamptz),
  inbox.contact_sla(text, int, int), inbox.contacts_list(jsonb), inbox.contact_detail(jsonb) from public, anon;
revoke all on function inbox.contact_phone_out(text, jsonb), inbox.contact_stage(text, timestamptz, timestamptz),
  inbox.contact_sla(text, int, int) from authenticated;
grant execute on function inbox.contacts_list(jsonb), inbox.contact_detail(jsonb) to authenticated, service_role;

commit;
