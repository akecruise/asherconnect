-- 023_sla_case_status.sql  ·  เฟส A: ตรรกะสถานะเคส + SLA
--
-- ปัญหาที่แก้: สถานะเคยมาจาก connect_private.case_state.waiting_since ซึ่งตั้งค่าด้วย
--   update ... where conversation_id=... ใน connect_private.receive_event()
-- ★ update ที่ไม่เจอแถวไม่ใช่ error มันเงียบ — บทสนทนาที่ยังไม่เคยมีแถวใน case_state
--   จึงได้ waiting_since = NULL ทั้งที่ลูกค้าทักค้างอยู่ แล้วหน้าจอแปลว่า "ตอบแล้ว"
--   (ยืนยันจากข้อมูลจริงบน production 2026-09-15: เคส 'ลูกค้าทดสอบ' last_sender=contact
--    แต่ไม่มีแถวใน case_state เลย)
--
-- ★ หัวแชทกับการ์ด "ใช้แหล่งเดียวกันอยู่แล้ว" — ทั้งคู่อ่าน waiting_since
--   บั๊กจึงไม่ใช่สองแหล่งไม่ตรงกัน แต่คือแหล่งเดียวที่ผิดพร้อมกันทั้งสองที่
--   ทางแก้คือนิยามสถานะจาก "ข้อความจริง" ซึ่งไม่มีทางหาย ไม่ใช่จากตารางสถานะที่อาจไม่มีแถว
--
-- ของเดิมไม่ถูกลบ: case_state.waiting_since ยังอยู่และยังถูก bot/รายงานใช้ตามเดิม
--   ไฟล์นี้เพิ่ม "แหล่งความจริงสำหรับการแสดงสถานะ" ขึ้นมาใหม่เท่านั้น

begin;

-- ═══════════════════════════════════════════════ 1. ค่าตั้งของ SLA
--
-- แยกออกมาเป็น key/value เพราะค่าพวกนี้ต้องแก้ได้โดยไม่ต้อง deploy
-- และเฟส E ต้องเพิ่ม "SLA รายช่องทาง" ทีหลังโดยไม่แตะข้อมูลเก่า
create table if not exists inbox.settings (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table inbox.settings is 'ค่าตั้งระดับระบบของ inbox — แก้ได้จาก connect_private.api(''setting_set'') โดย admin/manager';

insert into inbox.settings(key, value, note) values
  ('sla_minutes',     to_jsonb(10),               'ต้องตอบลูกค้าภายในกี่นาที (นับเฉพาะเวลานอกช่วงหยุดนับ)'),
  ('sla_pause_start', to_jsonb('00:00'::text),    'เริ่มหยุดนับ SLA · เวลาไทย'),
  ('sla_pause_end',   to_jsonb('06:00'::text),    'เลิกหยุดนับ SLA · เวลาไทย')
on conflict (key) do nothing;

-- ตัวอ่านค่า: รับค่า default มาด้วยเสมอ เพื่อให้ฟังก์ชันที่เรียกยังทำงานได้
-- แม้แถวจะถูกลบ — บทเรียนตรง ๆ จากบั๊กที่ไฟล์นี้กำลังแก้อยู่
create or replace function inbox.setting_int(p_key text, p_default int)
returns int language sql stable as $fn$
  select coalesce((select (value #>> '{}')::int from inbox.settings where key = p_key), p_default)
$fn$;

create or replace function inbox.setting_time(p_key text, p_default time)
returns time language sql stable as $fn$
  select coalesce((select (value #>> '{}')::time from inbox.settings where key = p_key), p_default)
$fn$;

-- ═══════════════════════════════════════════════ 2. นาทีที่นับจริง
--
-- นับเฉพาะนาทีที่อยู่ "นอก" ช่วงหยุดนับ (ค่าตั้งต้น 00:00–06:00 เวลาไทย)
-- วิธี: เวลาทั้งหมด ลบ ส่วนที่ทับกับหน้าต่างหยุดนับของแต่ละวัน
--
-- ★ รองรับหน้าต่างที่คร่อมเที่ยงคืนด้วย (เช่น 22:00–06:00) โดยตัดเป็นสองชิ้นต่อวัน
--   ถึงตอนนี้จะยังไม่ได้ใช้ แต่ถ้าไม่เผื่อไว้ วันที่มีคนเปลี่ยนค่าเป็น 22:00
--   ฟังก์ชันจะคืนค่าเพี้ยนเงียบ ๆ ไม่ error ให้จับได้
create or replace function inbox.sla_elapsed_minutes(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql
stable
as $fn$
declare
  v_tz constant text := 'Asia/Bangkok';
  f timestamp; t timestamp; ps time; pe time;
  v_total numeric; v_pause numeric;
begin
  if p_from is null or p_to is null or p_to <= p_from then return 0; end if;

  f  := p_from at time zone v_tz;
  t  := p_to   at time zone v_tz;
  ps := inbox.setting_time('sla_pause_start', time '00:00');
  pe := inbox.setting_time('sla_pause_end',   time '06:00');

  v_total := extract(epoch from (t - f)) / 60;
  if ps = pe then return greatest(0, floor(v_total))::int; end if;

  -- เผื่อวันหน้า-หลังข้างละวัน เพราะหน้าต่างแบบคร่อมเที่ยงคืนจะมีชิ้นส่วนยื่นมาจากวันก่อนหน้า
  select coalesce(sum(greatest(0, extract(epoch from (least(t, w.e) - greatest(f, w.s))) / 60)), 0)
    into v_pause
    from generate_series(date_trunc('day', f) - interval '1 day',
                         date_trunc('day', t) + interval '1 day',
                         interval '1 day') as d(day)
    cross join lateral (
      select * from (values
        -- ชิ้นหลัก: ps → pe (หรือ ps → เที่ยงคืน ถ้าหน้าต่างคร่อมวัน)
        (d.day + ps, case when ps < pe then d.day + pe else d.day + interval '1 day' end),
        -- ชิ้นหลังเที่ยงคืน: มีจริงเฉพาะตอนหน้าต่างคร่อมวัน ไม่งั้นกว้างศูนย์แล้วถูกกรองทิ้ง
        (d.day, case when ps < pe then d.day else d.day + pe end)
      ) x(s, e)
      where x.e > x.s
    ) w;

  return greatest(0, floor(v_total - v_pause))::int;
end
$fn$;

comment on function inbox.sla_elapsed_minutes(timestamptz, timestamptz)
  is 'นาทีที่นับเข้า SLA ระหว่างสองเวลา — ตัดช่วงหยุดนับตาม inbox.settings ออกแล้ว';

-- ═══════════════════════════════════════════════ 3. สถานะเคส · นิยามที่เดียว
--
-- late   ข้อความล่าสุดเป็นของลูกค้า ยังไม่มีเซลส์ตอบ และเกิน sla_minutes แล้ว
-- new    เหมือน late แต่ยังไม่ถึงเวลา
-- wait   เซลส์ตอบไปแล้ว (ข้อความของเซลส์ใหม่กว่าข้อความลูกค้าทุกตัว)
-- closed ปิดเคสแล้ว
--
-- ★ waiting_since = ข้อความ "แรก" ที่ลูกค้าทักหลังเซลส์ตอบครั้งล่าสุด ไม่ใช่ข้อความล่าสุด
--   ลูกค้าทักรัว 3 ที = รอมาตั้งแต่ทีแรก ไม่ใช่เพิ่งรอตอนทีที่สาม
--   ถ้านับจากทีล่าสุด ยิ่งลูกค้าทวงถี่ เคสยิ่งดูเหมือนเพิ่งเข้ามา แล้วจะหล่นจากจอ
--
-- ★ bot / system ไม่นับเป็นการตอบของเซลส์ (ตามสเปก) จึงกรองเหลือ sender_type='agent'
-- ★ follow / unfollow ไม่ใช่คำถามที่ต้องตอบ จึงนับเฉพาะ event_type message กับ postback
create or replace view inbox.case_status as
select
  c.id                                            as conversation_id,
  c.inbox_id,
  c.status                                        as conversation_status,
  w.waiting_since,
  case
    when c.status = 'resolved'   then 'closed'
    when w.waiting_since is null then 'wait'
    when inbox.sla_elapsed_minutes(w.waiting_since, now())
         >= inbox.setting_int('sla_minutes', 10)  then 'late'
    else 'new'
  end                                             as case_status,
  case
    -- ★ แชททดสอบไม่นับ SLA — แต่ยังต้องโผล่บนหน้าจอพร้อมแท็ก "ทดสอบ" (sql/031)
    --   จึงตัดที่การนับ ไม่ใช่ตัดแถวทิ้งจาก view
    when c.is_test then null
    when c.status = 'resolved' or w.waiting_since is null then null
    else inbox.sla_elapsed_minutes(w.waiting_since, now())
  end                                             as waiting_minutes,
  inbox.setting_int('sla_minutes', 10)            as sla_minutes,
  c.is_test                                       as is_test
from inbox.conversation c
left join lateral (
  select min(m.created_at) as waiting_since
    from inbox.message m
   where m.conversation_id = c.id
     and m.sender_type = 'contact'
     and m.event_type in ('message', 'postback')
     and m.created_at > coalesce((select max(a.created_at)
                                    from inbox.message a
                                   where a.conversation_id = c.id
                                     and a.sender_type = 'agent'), '-infinity'::timestamptz)
) w on true;

comment on view inbox.case_status is
  'แหล่งความจริงเดียวของสถานะเคส — หน้าจอ ชิปกรอง และรายงาน ต้องอ่านจากที่นี่เท่านั้น';

-- ไม่เปิดให้ authenticated อ่านตรง ๆ: view ไม่ได้ตั้ง security_invoker
-- ถ้าเปิด จะข้าม RLS ของ inbox.message ไปทั้งดุ้น ทางเข้าเดียวคือ connect_private.api
revoke all on inbox.settings from public, anon, authenticated;
revoke all on inbox.case_status from public, anon, authenticated;
grant select on inbox.case_status to service_role;
grant select, insert, update on inbox.settings to service_role;

commit;
