-- เทสต์ว่า external_id ถูกส่งออกมาถึงหน้าจอจริง และจับคู่ถูกคน
-- ★ อ่านอย่างเดียว อยู่ในทรานแซกชันที่ rollback ทิ้ง · ไม่พิมพ์ชื่อหรือ id ของลูกค้า
\set ON_ERROR_STOP on
begin;

do $do$
declare
  v_admin uuid := (select user_id from core.profile where role='admin' and is_active order by user_id limit 1);
  v_rows jsonb;
  v_conv uuid;
  v_detail jsonb;
  v_expected text;
  v_got text;
  v_with int; v_total int;
begin
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  -- ── 1. list ต้องมีคีย์ external_id ทุกแถว
  v_rows := connect_private.api('list', '{"filter":"all"}'::jsonb);
  select count(*) into v_total from jsonb_array_elements(v_rows);
  assert v_total > 0, 'ไม่มีเคสให้ทดสอบ';
  assert not exists (select 1 from jsonb_array_elements(v_rows) r where not (r ? 'external_id')),
    'บางแถวใน list ไม่มีคีย์ external_id';
  select count(*) into v_with from jsonb_array_elements(v_rows) r where r->>'external_id' is not null;
  raise notice '1. list มีคีย์ external_id ครบ %  แถว (มีค่าจริง % แถว) : ผ่าน', v_total, v_with;

  -- ── 2. ★ ค่าที่ได้ต้องตรงกับ core.contact_identity ของ "ช่องทางนั้น" จริง ๆ
  --    ข้อนี้คือข้อที่จะจับได้ว่า join ผิดคีย์ ซึ่งจะให้ NULL เงียบ ๆ ไม่ error
  for v_conv, v_got in
    select (r->>'id')::uuid, r->>'external_id' from jsonb_array_elements(v_rows) r
  loop
    select ci.external_id into v_expected
      from inbox.conversation c
      join inbox.inbox i on i.id = c.inbox_id
      left join core.contact_identity ci
             on ci.contact_id = c.contact_id
            and ci.channel = i.channel
            and ci.account_key = c.inbox_id::text
     where c.id = v_conv;
    assert v_got is not distinct from v_expected,
      format('เคส %s: list ให้ external_id ไม่ตรงกับในฐาน', v_conv);
  end loop;
  raise notice '2. external_id ทุกแถวตรงกับ core.contact_identity : ผ่าน';

  -- ── 3. detail ต้องมี contact.external_id ด้วย
  select (r->>'id')::uuid into v_conv from jsonb_array_elements(v_rows) r
   where r->>'external_id' is not null limit 1;
  if v_conv is null then
    raise notice '3. ไม่มีเคสที่มี external_id ให้ทดสอบ detail — ข้าม';
  else
    v_detail := connect_private.api('detail', jsonb_build_object('id', v_conv));
    assert v_detail->'contact' ? 'external_id', 'detail.contact ไม่มีคีย์ external_id';
    assert (v_detail->'contact'->>'external_id') is not null, 'detail.contact.external_id เป็น null ทั้งที่ list มีค่า';
    assert (v_detail->'contact'->>'external_id') =
           (select r->>'external_id' from jsonb_array_elements(v_rows) r where (r->>'id')::uuid = v_conv),
      'detail กับ list ให้ external_id ไม่ตรงกัน';
    raise notice '3. detail.contact.external_id ตรงกับ list : ผ่าน';
  end if;

  -- ── 4. ของเดิมต้องไม่หาย
  assert v_detail->'contact' ? 'display_name', 'detail.contact หาย display_name';
  assert v_detail->'contact' ? 'phone', 'detail.contact หาย phone';
  assert v_detail ? 'last_agent_reply', 'detail หาย last_agent_reply (ของ 025)';
  assert not exists (select 1 from jsonb_array_elements(v_rows) r where not (r ? 'case_status')),
    'list หาย case_status (ของ 024)';
  raise notice '4. ฟิลด์เดิมจาก 024/025 ยังอยู่ครบ : ผ่าน';

  raise notice '── ผ่านครบ 4 ข้อ ──';
end
$do$;

rollback;
