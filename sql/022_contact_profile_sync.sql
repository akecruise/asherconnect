-- 022_contact_profile_sync.sql
--
-- เติมชื่อ/อีเมลของลูกค้าจากกล่องข้อความของเพจ ลง core.contact
--
-- ทำไมต้องมาทางนี้:
-- webhook ของ Messenger ให้มาแต่ PSID ซึ่งเป็นเลขทึบ บอกไม่ได้ว่าใคร
-- และ `GET /{PSID}?fields=name` ก็เรียกไม่ได้เพราะไม่มีสิทธิ์ pages_user_profile
-- แต่ `GET /{page}/conversations?fields=participants` คืน name กับ email มาให้
-- ด้วยสิทธิ์ที่มีอยู่แล้ว (pages_messaging) — คนละประตู ข้อมูลเดียวกัน
--
-- ★ ฝั่ง Node แค่ไปหยิบของมา การตัดสินว่าจะเขียนทับอะไรบ้างอยู่ในนี้ที่เดียว
--   ตามกติกาของโปรเจกต์ที่ให้กฎธุรกิจอยู่ในฐาน ไม่ใช่ในโค้ดแอป

create or replace function inbox.sync_contact_profile(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_channel text := p_data->>'channel';
  v_person  jsonb;
  v_name    text;
  v_email   text;
  v_contact uuid;
  v_named   int := 0;   -- เติมชื่อที่ยังว่างอยู่
  v_kept    int := 0;   -- มีชื่ออยู่แล้ว เก็บของเดิมไว้
  v_unknown int := 0;   -- ยังไม่เคยคุยผ่านระบบนี้ จึงไม่มีแถวให้เติม
  v_skipped int := 0;   -- ขอลบข้อมูลไปแล้ว ห้ามแตะ
begin
  if coalesce(v_channel,'') = '' then raise exception 'invalid_request'; end if;

  for v_person in select * from jsonb_array_elements(coalesce(p_data->'people','[]'::jsonb)) loop
    v_name  := nullif(btrim(coalesce(v_person->>'name','')), '');
    v_email := nullif(btrim(coalesce(v_person->>'email','')), '');

    select ci.contact_id into v_contact
      from core.contact_identity ci
     where ci.channel = v_channel and ci.external_id = v_person->>'external_id'
     limit 1;

    -- คนที่ยังไม่เคยทักผ่านช่องทางนี้เข้าระบบ จะยังไม่มีแถว — ไม่สร้างใหม่ที่นี่
    -- การสร้างลูกค้าเป็นหน้าที่ของ receive() ตอนข้อความเข้าจริง ไม่ใช่ของตัวเก็บชื่อ
    if v_contact is null then v_unknown := v_unknown + 1; continue; end if;

    -- ★ ลบข้อมูลตามคำขอไปแล้ว ห้ามเอาชื่อกลับมาใส่
    if exists (select 1 from core.contact c where c.id = v_contact and c.anonymized_at is not null) then
      v_skipped := v_skipped + 1; continue;
    end if;

    -- ★ ชื่อจาก Facebook เก็บไว้ใน extra เสมอ แต่ display_name เติมเฉพาะตอนที่ยังว่าง
    --   เพราะชื่อที่เซลส์พิมพ์เองมีค่ากว่าชื่อโปรไฟล์ (ลูกค้าตั้งชื่อเล่น/ชื่อร้านกันเยอะ)
    --   ถ้าเขียนทับทุกรอบ ชื่อจริงที่คนแก้ไว้จะหายทุกครั้งที่ตัวเก็บวิ่ง
    update core.contact c
       set extra = c.extra || jsonb_strip_nulls(jsonb_build_object(
                     'fb_name', v_name, 'fb_email', v_email,
                     'fb_synced_at', to_jsonb(now()))),
           display_name = coalesce(nullif(btrim(c.display_name),''), v_name),
           email        = coalesce(c.email, v_email),
           updated_at   = now()
     where c.id = v_contact;

    if exists (select 1 from core.contact c
                where c.id = v_contact and btrim(coalesce(c.display_name,'')) = coalesce(v_name,''))
       and v_name is not null then
      v_named := v_named + 1;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;

  return jsonb_build_object('named', v_named, 'kept', v_kept,
                            'unknown', v_unknown, 'skipped', v_skipped);
end $$;

-- ตัวเก็บวิ่งด้วยสิทธิ์ service เท่านั้น ไม่ใช่ของที่หน้าเว็บเรียกได้
revoke all on function inbox.sync_contact_profile(jsonb) from public, anon, authenticated;
grant execute on function inbox.sync_contact_profile(jsonb) to service_role;

comment on function inbox.sync_contact_profile(jsonb) is
  'เติมชื่อ/อีเมลจาก participants ของกล่องข้อความเพจ — เขียน display_name เฉพาะตอนที่ยังว่าง';
