-- 037 selftest — รันหลัง migration และเปิดด้วย asher.allow_db_tests=1
do $guard$
begin
  if current_setting('asher.allow_db_tests', true) is distinct from '1' then
    raise exception 'ข้าม selftest — ต้องตั้ง asher.allow_db_tests=1 ก่อน';
  end if;
end
$guard$;

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'inbox' and table_name = 'message' and column_name = 'media') then
    raise exception 'ไม่มี inbox.message.media';
  end if;

  -- ลายเซ็นเหล่านี้คือ REST RPC contract ของ rpcDirect(Content-Profile: inbox)
  if to_regprocedure('inbox.media_attach(uuid,jsonb)') is null
     or to_regprocedure('inbox.media_of(uuid)') is null
     or to_regprocedure('inbox.media_access(text)') is null then
    raise exception 'REST media RPC signature ไม่ครบ';
  end if;
  if to_regprocedure('connect_private.media_attach(uuid,jsonb)') is null
     or to_regprocedure('connect_private.media_of(uuid)') is null
     or to_regprocedure('connect_private.media_access(text)') is null then
    raise exception 'private media function signature ไม่ครบ';
  end if;

  if connect_private.media_of('00000000-0000-0000-0000-000000000000'::uuid) <> '{}'::jsonb then
    raise exception 'media_of ต้องคืน {} เมื่อไม่มีข้อมูล';
  end if;
  if connect_private.media_access('missing/path.jpg') then
    raise exception 'media_access ต้องไม่อนุญาต path ที่ไม่ผูกกับ message';
  end if;
  if connect_private.media_attach('00000000-0000-0000-0000-000000000000'::uuid,
      '[{"path":"x/y.jpg","mime":"image/jpeg","bytes":1}]'::jsonb) then
    raise exception 'media_attach ต้องคืน false เมื่อไม่พบ message';
  end if;
end
$$;

do $$
begin
  begin
    perform connect_private.media_attach(gen_random_uuid(), '[]'::jsonb);
    raise exception 'should_have_raised';
  exception when others then
    if sqlerrm <> 'media_must_be_nonempty_array' then raise; end if;
  end;
end
$$;

-- ACL: private helpers ห้าม user tokens; REST reads เปิดเฉพาะ authenticated;
-- REST attach เปิดเฉพาะ service_role และ PUBLIC ต้องไม่มีสิทธิ์โดยปริยาย
do $$
begin
  if has_function_privilege('anon', 'connect_private.media_attach(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'connect_private.media_attach(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'connect_private.media_of(uuid)', 'execute')
     or has_function_privilege('authenticated', 'connect_private.media_access(text)', 'execute') then
    raise exception 'private media ACL เปิดกว้างเกินไป';
  end if;
  if not has_function_privilege('service_role', 'inbox.media_attach(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'inbox.media_attach(uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'inbox.media_attach(uuid,jsonb)', 'execute') then
    raise exception 'inbox.media_attach ACL ไม่ถูกต้อง';
  end if;
  if not has_function_privilege('authenticated', 'inbox.media_of(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'inbox.media_access(text)', 'execute')
     or has_function_privilege('anon', 'inbox.media_of(uuid)', 'execute')
     or has_function_privilege('anon', 'inbox.media_access(text)', 'execute') then
    raise exception 'REST media read ACL ไม่ถูกต้อง';
  end if;
  if exists (
    select 1
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
     where p.oid in (
       'connect_private.media_attach(uuid,jsonb)'::regprocedure,
       'connect_private.media_of(uuid)'::regprocedure,
       'connect_private.media_access(text)'::regprocedure,
       'inbox.media_attach(uuid,jsonb)'::regprocedure,
       'inbox.media_of(uuid)'::regprocedure,
       'inbox.media_access(text)'::regprocedure
     )
       and acl.grantee = 0
       and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC ยังเรียก media function ได้';
  end if;
end
$$;

-- ไม่มี JWT/profile ต้องถูกปฏิเสธแม้ role postgres จะเรียกตัว wrapper ได้
do $$
begin
  begin
    perform inbox.media_access('missing/path.jpg');
    raise exception 'should_have_raised';
  exception when sqlstate '42501' then null;
  end;
end
$$;

-- ฉากจริง: path ต้องผูกกับ message/inbox และ active Connect profile เท่านั้น
insert into auth.users(id) values ('cc370000-0000-0000-0000-000000000001');
insert into core."user"(id, email) values ('cc370000-0000-0000-0000-000000000001', 'media-037@test.local');
insert into core.profile(user_id, role, is_active)
values ('cc370000-0000-0000-0000-000000000001', 'sales', true);
insert into core.project(id, code, name)
values ('cc370000-0000-0000-0000-000000000010', '_SELFTEST_MEDIA_037', 'media selftest');
insert into core.contact(id, display_name)
values ('cc370000-0000-0000-0000-000000000020', 'media selftest');
insert into inbox.inbox(id, channel, project_id, name)
values ('cc370000-0000-0000-0000-000000000030', 'test', 'cc370000-0000-0000-0000-000000000010', 'media selftest');
insert into inbox.conversation(id, inbox_id, contact_id)
values ('cc370000-0000-0000-0000-000000000040', 'cc370000-0000-0000-0000-000000000030', 'cc370000-0000-0000-0000-000000000020');
insert into inbox.message(id, conversation_id, sender_type, content, content_type, media)
values (
  'cc370000-0000-0000-0000-000000000050',
  'cc370000-0000-0000-0000-000000000040',
  'contact', '[ลูกค้าส่งสื่อแนบ]', 'image',
  '[{"path":"cc370000-0000-0000-0000-000000000030/cc370000-0000-0000-0000-000000000050.jpg","mime":"image/jpeg","bytes":1}]'::jsonb
);

select set_config('request.jwt.claim.sub', 'cc370000-0000-0000-0000-000000000001', true);
do $$
begin
  if not inbox.media_access('cc370000-0000-0000-0000-000000000030/cc370000-0000-0000-0000-000000000050.jpg') then
    raise exception 'active sales ต้องอ่าน path ที่ผูกกับ message ได้';
  end if;
  if inbox.media_access('cc370000-0000-0000-0000-000000000030/cc370000-0000-0000-0000-000000000099.jpg') then
    raise exception 'path ที่ไม่ผูกกับ message ต้องถูกปฏิเสธ';
  end if;
  if inbox.media_of('cc370000-0000-0000-0000-000000000040'::uuid)
       -> 'cc370000-0000-0000-0000-000000000050' is null then
    raise exception 'active sales ต้องอ่าน media map ของ conversation ได้';
  end if;
end
$$;

update core.profile set is_active = false
 where user_id = 'cc370000-0000-0000-0000-000000000001';
do $$
begin
  begin
    perform inbox.media_access('cc370000-0000-0000-0000-000000000030/cc370000-0000-0000-0000-000000000050.jpg');
    raise exception 'should_have_raised';
  exception when sqlstate '42501' then null;
  end;
end
$$;

rollback;

\echo '037 selftest ผ่านหมด'
