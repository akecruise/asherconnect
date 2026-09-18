-- Phase 9: rollback-only lifecycle, authorization, atomicity, preview and history.
do $$ begin
  if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'DB tests disabled'; end if;
end $$;
begin;
do $test$
declare
  mgr uuid; adm uuid; sales uuid; item uuid; src uuid; r jsonb; b jsonb; v jsonb; n integer;
begin
  select user_id into mgr from core.profile where role='manager' and is_active limit 1;
  select user_id into adm from core.profile where role='admin' and is_active limit 1;
  select user_id into sales from core.profile where role='sales' and is_active limit 1;
  if mgr is null or adm is null or sales is null then raise exception 'Missing test roles'; end if;
  select id into src from answer_hub.source_registry where source_code='PROJECT_PROFILE';
  if src is null then select id into src from answer_hub.source_registry limit 1; end if;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',mgr)::text,true);
  r:=inbox.ah_editor_options();
  assert jsonb_array_length(r->'categories')>=10, 'editor categories';
  assert r->>'role'='manager', 'editor role';
  b:=jsonb_build_array(jsonb_build_object('variable_name','project_name','source_id',src,'source_field','name','required',true));
  r:=inbox.ah_save(jsonb_build_object('answer_key','selftest_phase9_key','title','[__selftest__] editor','body_template','Hello {{project_name}}','bindings',b));
  item:=(r->>'id')::uuid;
  assert r->>'status'='draft', 'create draft';
  begin
    perform inbox.ah_save(jsonb_build_object('answer_key','selftest_phase9_key','title','duplicate','body_template','x'));
    raise exception 'Duplicate accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_duplicate' then raise; end if; end;
  begin
    perform inbox.ah_save(jsonb_build_object('answer_key','bad key!','title','bad','body_template','x'));
    raise exception 'Invalid key accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_invalid' then raise; end if; end;
  r:=inbox.ah_save(jsonb_build_object('id',item,'submit',true,'question_examples',jsonb_build_array('Question?'),'attachments',jsonb_build_array('https://example.com/guide.pdf')));
  assert r->>'status'='review', 'submit existing draft';
  assert r->'question_examples'->>0='Question?', 'examples persisted';
  assert r->'attachments'->>0='https://example.com/guide.pdf', 'attachments persisted';
  begin
    perform inbox.ah_approve(jsonb_build_object('id',item)); raise exception 'Manager approved';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_not_allowed' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',adm)::text,true);
  perform inbox.ah_approve(jsonb_build_object('id',item));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',mgr)::text,true);
  r:=inbox.ah_save(jsonb_build_object('id',item,'title','[__selftest__] edited','bindings','[]'::jsonb));
  assert r->>'status'='review' and r->>'approved_by' is null, 'edit revokes approval';
  v:=inbox.ah_versions(jsonb_build_object('id',item));
  assert v->'rows'->0->>'answer_key'='selftest_phase9_key', 'key in version';
  assert jsonb_array_length(v->'rows'->0->'snapshot'->'bindings')=1, 'bindings snapshot';
  assert v->'rows'->0->'snapshot'->'attachments'->>0='https://example.com/guide.pdf', 'attachment snapshot';
  -- All changes roll back when one binding fails.
  begin
    perform inbox.ah_save(jsonb_build_object('id',item,'title','MUST NOT PERSIST','bindings',jsonb_build_array(jsonb_build_object('variable_name','bad!', 'source_id',src))));
    raise exception 'Invalid binding accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_invalid' then raise; end if; end;
  r:=inbox.ah_get(jsonb_build_object('id',item));
  assert r->'item'->>'title'='[__selftest__] edited', 'atomic save';
  begin
    perform inbox.ah_save(jsonb_build_object('id',item,'valid_from','2026-09-20','valid_to','2026-09-01'));
    raise exception 'Invalid dates accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_invalid' then raise; end if; end;
  begin
    perform inbox.ah_save(jsonb_build_object('id',item,'attachments',jsonb_build_array('javascript:alert(1)')));
    raise exception 'Unsafe attachment accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_invalid' then raise; end if; end;
  r:=inbox.ah_preview_data(jsonb_build_object('bindings',b,'context','{}'::jsonb));
  assert jsonb_array_length(r->'missing')=1, 'preview missing ERP data';
  r:=inbox.ah_preview_data(jsonb_build_object('bindings',jsonb_set(b,'{0,fallback_text}','"fallback"'::jsonb)));
  assert r->'values'->>'project_name'='fallback', 'preview fallback';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',adm)::text,true);
  perform inbox.ah_approve(jsonb_build_object('id',item));
  perform inbox.ah_binding_save((b->0)||jsonb_build_object('answer_item_id',item));
  r:=inbox.ah_get(jsonb_build_object('id',item));
  assert r->'item'->>'status'='review', 'direct binding edit revokes approval';
  perform inbox.ah_approve(jsonb_build_object('id',item));
  perform inbox.ah_retire(jsonb_build_object('id',item,'reason','[__selftest__] retire'));
  begin
    perform inbox.ah_save(jsonb_build_object('id',item,'title','retired edit'));
    raise exception 'Retired edit accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_state_not_allowed' then raise; end if; end;
  r:=inbox.ah_binding_list(jsonb_build_object('answer_item_id',item));
  begin
    perform inbox.ah_binding_delete(jsonb_build_object('id',r->'rows'->0->>'id'));
    raise exception 'Retired binding delete accepted';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_state_not_allowed' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sales)::text,true);
  begin
    perform inbox.ah_editor_options(); raise exception 'Sales editor allowed';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_not_allowed' then raise; end if; end;
  begin
    perform inbox.ah_preview_data('{}'); raise exception 'Sales preview allowed';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_not_allowed' then raise; end if; end;
  begin
    perform inbox.ah_save('{"title":"sales","body_template":"x"}'); raise exception 'Sales save allowed';
  exception when sqlstate 'P0001' then if sqlerrm<>'ah_not_allowed' then raise; end if; end;
  raise notice 'Phase 9 lifecycle / atomicity / preview / permissions PASS';
end $test$;
rollback;
