-- 023_channel_health.sql
--
-- ไฟสถานะของ chip ช่องทางบนหน้า Workspace
--
-- ก่อนหน้านี้จุดบน chip เป็นสีคงที่ บอกได้แค่ว่า "ตั้งค่าครบใน channels.json ไหม"
-- ซึ่งเป็นคนละคำถามกับ "ช่องทางนี้ยังรับข้อความอยู่ไหม" — เช้าวันที่ 15 ก.ย. 2026
-- ลูกค้าทักเพจแล้วไม่มีเคสเข้าเลยติดต่อกันหลายชั่วโมง โดยหน้าจอไม่มีอะไรบอกสักตัว
--
-- ★ ไม่แตะ CHECK ของ connect_private.webhook_log
--   status รับได้แค่ pending/processing/done/failed อยู่แล้ว
--   คำขอที่ลายเซ็นไม่ผ่านจึงบันทึกเป็น 'failed' + last_error แทนการเพิ่มค่าใหม่
--   ได้ผลเท่ากันสำหรับการตัดสินสี และไม่ต้องไปแก้ตารางที่ worker ใช้อยู่

-- ---------------------------------------------------------------------
-- 1) บันทึกคำขอที่ถูกปฏิเสธเพราะลายเซ็นไม่ผ่าน
-- ---------------------------------------------------------------------
-- ★ ห้ามเก็บ payload ดิบของคำขอที่ยังพิสูจน์ไม่ได้ว่าเป็นของเรา
--   ลายเซ็นไม่ผ่าน = ยังไม่รู้ว่าใครส่ง ถ้าเก็บทั้งก้อนเท่ากับเอาข้อมูลของคนอื่น
--   (อาจเป็นข้อความลูกค้าของเพจอื่น) มาไว้ในบันทึกของเรา
--   เก็บแค่เปลือกนอกที่พอไล่ต้นทางได้ ตามเหตุผลเดียวกับ matchesDestination ใน providers.mjs
create or replace function inbox.webhook_reject(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_id bigint;
begin
  if coalesce(p_data->>'channel_key','') = '' then raise exception 'invalid_request'; end if;

  insert into connect_private.webhook_log
    (channel_key, channel, inbox_id, payload, status, attempts, events_count, last_error, processed_at)
  values (
    p_data->>'channel_key',
    coalesce(p_data->>'channel','unknown'),
    nullif(p_data->>'inbox_id','')::uuid,
    jsonb_strip_nulls(jsonb_build_object(
      'rejected', true,
      'reason',   coalesce(p_data->>'reason','invalid_signature'),
      'bytes',    (p_data->>'bytes')::int,
      'ua',       p_data->>'ua',
      'shape',    p_data->'shape')),
    'failed', 0, 0,
    coalesce(p_data->>'reason','invalid_signature'),
    now())
  returning id into v_id;

  return jsonb_build_object('log_id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- 2) สถานะของแต่ละช่องทาง
-- ---------------------------------------------------------------------
-- คืนเป็น object ที่คีย์คือ channel_key เพื่อให้ฝั่ง Node จับคู่กับ channels.json ได้ตรง ๆ
--
-- fails_since_ok = ล้มเหลวติดกันกี่ครั้งนับจากใบที่สำเร็จล่าสุด
--   ★ นับ "ตั้งแต่ใบที่สำเร็จล่าสุด" ไม่ใช่ "ใน 24 ชม." เพราะช่องทางที่ตายสนิท
--     จะไม่มีทั้งสำเร็จและล้มเหลวใหม่ ๆ การนับแบบหน้าต่างเวลาจะทำให้มันกลับมาเขียว
--     เองเมื่อเวลาผ่านไป ทั้งที่ไม่มีอะไรดีขึ้น
create or replace function inbox.channel_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- ★ "สำเร็จ" กับ "มีข้อความจริง" ไม่ใช่เรื่องเดียวกัน
  --   การกดปุ่ม Verify ใน LINE Developers และ echo/delivery/read ของ Meta
  --   ล้วนเป็น status='done' แต่ events_count = 0 คือไม่มีอะไรเข้าระบบเลย
  --   ถ้าใช้ done เฉย ๆ ตัดสินสี ช่องทางที่ลูกค้าทักไม่ถึงจะขึ้นเขียวหลอกตา
  --   ซึ่งเป็นอาการเดียวกับที่ทำให้เช้า 15 ก.ย. ไม่มีใครรู้ว่าของเข้าไม่ได้
  with ทุกใบ as (
    select w.channel_key,
           max(w.received_at)                                        as last_at,
           max(w.received_at) filter (where w.status = 'done')       as last_ok_at,
           max(w.received_at) filter (where w.status = 'done'
                                        and coalesce(w.events_count,0) > 0) as last_event_at,
           (array_agg(w.status     order by w.received_at desc))[1]  as last_status,
           (array_agg(w.last_error order by w.received_at desc))[1]  as last_error
      from connect_private.webhook_log w
     group by w.channel_key
  ),
  -- นับแยกเป็นอีกชั้น เพราะเงื่อนไขต้องอ้าง max() ของชั้นบน
  -- ใส่ไว้ใน filter ตรง ๆ ไม่ได้ SQL ไม่ให้ซ้อน aggregate ในเงื่อนไขของ aggregate
  ล้มติดกัน as (
    select w.channel_key, count(*) as n
      from connect_private.webhook_log w
      join ทุกใบ t on t.channel_key = w.channel_key
     where w.status = 'failed'
       and w.received_at > coalesce(t.last_ok_at, '-infinity'::timestamptz)
     group by w.channel_key
  )
  select coalesce(jsonb_object_agg(t.channel_key, jsonb_build_object(
           'last_ok_at',     t.last_ok_at,
           'last_event_at',  t.last_event_at,
           'last_at',        t.last_at,
           'last_status',    t.last_status,
           'last_error',     t.last_error,
           'fails_since_ok', coalesce(f.n, 0)
         )), '{}'::jsonb)
    from ทุกใบ t left join ล้มติดกัน f on f.channel_key = t.channel_key
$$;

-- ทั้งสองตัวเป็นของเบื้องหลัง ไม่ใช่ของที่หน้าเว็บเรียกเองได้
revoke all on function inbox.webhook_reject(jsonb) from public, anon, authenticated;
revoke all on function inbox.channel_health()       from public, anon, authenticated;
grant execute on function inbox.webhook_reject(jsonb) to service_role;
grant execute on function inbox.channel_health()      to service_role;

comment on function inbox.channel_health() is
  'สถานะ webhook ต่อ channel_key สำหรับไฟบน chip — done ล่าสุด, ใบล่าสุด, และจำนวนล้มเหลวติดกัน';
