-- 202609261000 media library selftest — รันหลัง migration และเปิดด้วย asher.allow_db_tests=1
-- ทั้งไฟล์อยู่ใน transaction แล้ว ROLLBACK — ไม่ทิ้งแถวไว้ในฐาน
-- ต้องมี core.profile ที่ active อย่างน้อย: sales 1 คน, marketing/manager/admin 1 คน
do $guard$
begin
  if current_setting('asher.allow_db_tests', true) is distinct from '1' then
    raise exception 'ข้าม selftest — ต้องตั้ง asher.allow_db_tests=1 ก่อน';
  end if;
end
$guard$;

begin;

create temp table _t(k text primary key, v text) on commit drop;
grant all on _t to authenticated;

do $$
declare v_sales uuid; v_editor uuid; v_conv uuid;
begin
  select user_id into v_sales from core.profile where role in ('sales','senior_sales') and is_active and not coalesce(test_only,false) limit 1;
  select user_id into v_editor from core.profile where role in ('marketing','manager','admin') and is_active and not coalesce(test_only,false) limit 1;
  select id into v_conv from inbox.conversation order by created_at desc limit 1;
  if v_sales is null or v_editor is null or v_conv is null then raise exception 'selftest ต้องมี sales + editor profile และ conversation อย่างน้อยอย่างละ 1'; end if;
  insert into _t values ('sales', v_sales), ('editor', v_editor), ('conv', v_conv);
end $$;

-- สัญญาของ REST RPC (rpcDirect Content-Profile: inbox)
do $$
begin
  if to_regprocedure('inbox.media_list(text,text,text,text,uuid,text)') is null
     or to_regprocedure('inbox.media_get(uuid[])') is null
     or to_regprocedure('inbox.media_path_allowed(text)') is null
     or to_regprocedure('inbox.media_create(jsonb)') is null
     or to_regprocedure('inbox.media_update(uuid,jsonb)') is null
     or to_regprocedure('inbox.media_archive(uuid)') is null
     or to_regprocedure('inbox.media_record_send(uuid,uuid[],uuid)') is null then
    raise exception 'media library RPC signature ไม่ครบ';
  end if;
  if has_function_privilege('anon', 'inbox.media_list(text,text,text,text,uuid,text)', 'execute')
     or has_function_privilege('anon', 'inbox.media_create(jsonb)', 'execute') then
    raise exception 'anon ต้องเรียก media_* ไม่ได้';
  end if;
  if exists (select 1 from inbox.media_asset where category is null) then raise exception 'category ต้องถูก backfill ครบ'; end if;
end $$;

-- ── sales: อัปโหลดได้แต่เป็น pending, บอทตั้งเองไม่ได้, แก้/นำออกไม่ได้ ──
select set_config('request.jwt.claim.sub', (select v from _t where k='sales'), true),
       set_config('request.jwt.claims', json_build_object('sub', (select v from _t where k='sales'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare r jsonb; v_id uuid;
begin
  r := inbox.media_create(jsonb_build_object('title','__selftest__ sales','project','naii','category','room',
        'storage_path','6f1c2a7e-3b1d-4d8e-9a55-5c0de1ba1b00/aaaaaaaa-0000-4000-8000-000000000001.jpg',
        'mime','image/jpeg','bytes',10,'public_url','https://x/library-media/a.jpg','bot_enabled',true));
  if r->>'status' <> 'pending' then raise exception 'sales upload ต้องเป็น pending, ได้ %', r->>'status'; end if;
  if (r->>'bot_enabled')::boolean then raise exception 'sales ต้องตั้ง bot_enabled เองไม่ได้'; end if;
  v_id := (r->>'id')::uuid;
  insert into _t values ('pending', v_id);
  if exists (select 1 from jsonb_array_elements(inbox.media_list()) e where e->>'id' = v_id::text) then
    raise exception 'รูป pending ต้องไม่อยู่ในคลังของเซลส์';
  end if;
  if not inbox.media_path_allowed('6f1c2a7e-3b1d-4d8e-9a55-5c0de1ba1b00/aaaaaaaa-0000-4000-8000-000000000001.jpg') then
    raise exception 'คนอัปโหลดต้องดูรูป pending ของตัวเองได้';
  end if;
  begin
    perform inbox.media_update(v_id, '{"status":"approved"}');
    raise exception 'should_have_raised';
  exception when others then if sqlerrm <> 'not_allowed' then raise; end if; end;
  begin
    perform inbox.media_archive(v_id);
    raise exception 'should_have_raised';
  exception when others then if sqlerrm <> 'not_allowed' then raise; end if; end;
end $$;

reset role;

-- ── editor: อนุมัติ, หมดอายุ, นำออก ──
select set_config('request.jwt.claim.sub', (select v from _t where k='editor'), true),
       set_config('request.jwt.claims', json_build_object('sub', (select v from _t where k='editor'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_id uuid := (select v from _t where k='pending')::uuid; r jsonb; v_expired uuid;
begin
  if not exists (select 1 from jsonb_array_elements(inbox.media_list(p_scope => 'manage')) e where e->>'id' = v_id::text) then
    raise exception 'editor ต้องเห็นรูป pending ในโหมด manage';
  end if;
  r := inbox.media_update(v_id, '{"status":"approved","bot_enabled":true,"category":"plan"}');
  if r->>'status' <> 'approved' or not (r->>'bot_enabled')::boolean or r->>'category' <> 'plan' then raise exception 'อนุมัติ/แก้ไม่ติด: %', r; end if;

  r := inbox.media_create(jsonb_build_object('title','__selftest__ expired','project','vibe','category','promo',
        'storage_path','6f1c2a7e-3b1d-4d8e-9a55-5c0de1ba1b00/aaaaaaaa-0000-4000-8000-000000000002.jpg',
        'mime','image/jpeg','bytes',10,'public_url','https://x/b.jpg','expires_at', now() - interval '1 day'));
  if r->>'status' <> 'approved' then raise exception 'editor upload ต้อง approved ทันที'; end if;
  v_expired := (r->>'id')::uuid;
  insert into _t values ('expired', v_expired);
  if exists (select 1 from jsonb_array_elements(inbox.media_list()) e where e->>'id' = v_expired::text) then
    raise exception 'รูปหมดอายุต้องไม่อยู่ในคลังปกติ';
  end if;
  -- ตัวกรองโครงการ: naii ต้องไม่เห็นรูป vibe
  if exists (select 1 from jsonb_array_elements(inbox.media_list(p_project => 'naii', p_scope => 'manage')) e where e->>'id' = v_expired::text) then
    raise exception 'filter project รั่ว';
  end if;
  begin
    perform inbox.media_update(v_id, '{"category":"floorplan"}');
    raise exception 'should_have_raised';
  exception when check_violation then null; end;
end $$;

reset role;

-- ── sales: เห็นรูปที่อนุมัติแล้ว, จดการส่ง, ป้าย "ส่งแล้ว", media_get กรองรูปหมดอายุ ──
select set_config('request.jwt.claim.sub', (select v from _t where k='sales'), true),
       set_config('request.jwt.claims', json_build_object('sub', (select v from _t where k='sales'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_id uuid := (select v from _t where k='pending')::uuid; v_expired uuid := (select v from _t where k='expired')::uuid;
        v_conv uuid := (select v from _t where k='conv')::uuid; r jsonb; n int;
begin
  if jsonb_array_length(inbox.media_get(array[v_id, v_expired])) <> 1 then raise exception 'media_get ต้องคืนเฉพาะรูปที่ใช้ได้'; end if;
  if connect_private.can_read(v_conv) then
    n := inbox.media_record_send(v_conv, array[v_id]);
    if n <> 1 then raise exception 'record_send ต้องจด 1 แถว'; end if;
    select e into r from jsonb_array_elements(inbox.media_list(p_conversation_id => v_conv)) e where e->>'id' = v_id::text;
    if r is null or not (r->>'sent_to_conversation')::boolean or (r->>'use_count')::int <> 1 then raise exception 'ป้ายส่งแล้ว/use_count ผิด: %', r; end if;
  end if;
end $$;

reset role;

-- ── archive: หายจากคลัง แต่ไม่แตะ active (quick reply เดิมไม่พัง) ──
select set_config('request.jwt.claim.sub', (select v from _t where k='editor'), true),
       set_config('request.jwt.claims', json_build_object('sub', (select v from _t where k='editor'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_id uuid := (select v from _t where k='pending')::uuid;
begin
  perform inbox.media_archive(v_id);
  if exists (select 1 from jsonb_array_elements(inbox.media_list(p_scope => 'manage')) e where e->>'id' = v_id::text) then raise exception 'archive แล้วยังโผล่'; end if;
  if inbox.media_path_allowed('6f1c2a7e-3b1d-4d8e-9a55-5c0de1ba1b00/aaaaaaaa-0000-4000-8000-000000000001.jpg') then raise exception 'archive แล้วยังเสิร์ฟไฟล์ได้'; end if;
end $$;
reset role;

do $$ begin
  if not (select active from inbox.media_asset where id = (select v from _t where k='pending')::uuid) then raise exception 'archive ต้องไม่แตะ active'; end if;
  raise notice 'media library selftest: ผ่านทั้งหมด';
end $$;

rollback;
