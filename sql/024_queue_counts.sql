-- 024_queue_counts.sql
--
-- จำนวนเคสของทุกตัวกรองในการเรียกครั้งเดียว
--
-- ของเดิมมีแต่ตัวเลขของ SLA และได้มาด้วยการให้เบราว์เซอร์ไล่ขอรายการทีละหน้า
-- แล้วนับเอง (refreshSlaCount ใน public/app.js) — ยิ่งเคสเยอะยิ่งช้า และได้มาแค่ตัวเดียว
-- ชิปตัวกรองต้องโชว์ตัวเลขทุกตัว จึงต้องนับที่ฐานทีเดียวจบ
--
-- ★ เงื่อนไขแต่ละตัวกรองคัดลอกจาก connect_private.api กิ่ง 'list' แบบตรงตัว
--   ถ้าสองที่นี้เขียนไม่เหมือนกัน ตัวเลขบนชิปจะไม่ตรงกับรายการที่เห็น
--   ซึ่งเป็นบั๊กที่ไม่มีใครจับได้จนกว่าจะมีคนนั่งนับเอง
--   วันที่แก้เงื่อนไขในกิ่ง list ต้องมาแก้ไฟล์นี้ด้วยเสมอ
--
-- ★ มองเห็นได้เท่าที่ connect_private.can_read() อนุญาต — ตัวเดียวกับที่ list ใช้
--   เซลส์จึงไม่เห็นตัวเลขของเคสที่ตัวเองเปิดดูไม่ได้

create or replace function inbox.queue_counts(p_search text default '')
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with เห็นได้ as (
    select c.id, c.assignee_id, c.status,
           s.waiting_since, s.appointment_at, s.follow_up_at
      from inbox.conversation c
      join core.contact ct on ct.id = c.contact_id
      left join connect_private.case_state s on s.conversation_id = c.id
     where connect_private.can_read(c.id)
       -- ค้นหาแบบเดียวกับ list เพื่อให้ตัวเลขบนชิปเดินตามช่องค้นหาไปด้วย
       and (coalesce(p_search,'') = ''
            or position(lower(p_search) in
                 lower(coalesce(ct.display_name,'') || ' ' || coalesce(ct.phone,''))) > 0)
  )
  select jsonb_build_object(
    'mine',       count(*) filter (where assignee_id = auth.uid() and status <> 'resolved'),
    'unassigned', count(*) filter (where assignee_id is null      and status <> 'resolved'),
    'waiting',    count(*) filter (where waiting_since is null    and status <> 'resolved'),
    'sla',        count(*) filter (where waiting_since <= now() - interval '30 minutes'
                                     and status <> 'resolved'),
    'today',      count(*) filter (where (appointment_at at time zone 'Asia/Bangkok')::date
                                       = (now() at time zone 'Asia/Bangkok')::date
                                     and status <> 'resolved'),
    'followup',   count(*) filter (where follow_up_at <= now()    and status <> 'resolved'),
    'closed',     count(*) filter (where status = 'resolved'),
    'all',        count(*) filter (where status <> 'resolved')
  )
  from เห็นได้
$$;

-- หน้าเว็บเรียกด้วย token ของคนที่ล็อกอิน ไม่ใช่ service — auth.uid() จึงเป็นคนจริง
revoke all on function inbox.queue_counts(text) from public, anon;
grant execute on function inbox.queue_counts(text) to authenticated, service_role;

comment on function inbox.queue_counts(text) is
  'จำนวนเคสของทุกตัวกรองในครั้งเดียว — เงื่อนไขต้องตรงกับกิ่ง list ใน connect_private.api เสมอ';
