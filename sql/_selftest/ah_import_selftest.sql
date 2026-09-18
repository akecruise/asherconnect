-- Phase 10: preview is read-only; commit is atomic and admin-only.
do $guard$ begin
  if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'set asher.allow_db_tests=1'; end if;
end $guard$;
begin;
do $test$
declare a uuid; s uuid; before_items int; before_batches int; p jsonb; r jsonb; denied boolean:=false;
begin
  select user_id into a from core.profile where role='admin' and is_active limit 1;
  select user_id into s from core.profile where role='sales' and is_active limit 1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a)::text,true);
  select count(*) into before_items from answer_hub.answer_item;
  select count(*) into before_batches from answer_hub.import_batch;
  set local role authenticated;
  p:=jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('_row',2,'category','price_promo','title','[__selftest__] import','body_template','body','answer_type','static','audience','both')));
  r:=inbox.ah_import_preview(p);
  reset role;
  if (r->>'new')::int<>1 or (select count(*) from answer_hub.answer_item)<>before_items or (select count(*) from answer_hub.import_batch)<>before_batches then raise exception 'preview mutated or misclassified'; end if;
  set local role authenticated;
  r:=inbox.ah_import_commit(p);
  reset role;
  if (r->>'count')::int<>1 or (select count(*) from answer_hub.answer_item)<>before_items+1 or (select count(*) from answer_hub.import_batch)<>before_batches+1 then raise exception 'commit/audit failed'; end if;
  set local role authenticated;
  -- An invalid second row aborts the entire batch, including the valid first row.
  begin
    perform inbox.ah_import_commit(jsonb_build_object('rows',jsonb_build_array(
      jsonb_build_object('category','price_promo','title','[__selftest__] atomic','body_template','ok'),
      jsonb_build_object('category','missing','title','bad','body_template','bad'))));
    raise exception 'invalid batch unexpectedly committed';
  exception when others then null; end;
  reset role;
  if exists(select 1 from answer_hub.answer_item where title='[__selftest__] atomic') then raise exception 'atomic rollback failed'; end if;
  set local role authenticated;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',s)::text,true);
  begin perform inbox.ah_import_preview(p); exception when others then denied:=true; end;
  if not denied then raise exception 'sales preview unexpectedly allowed'; end if;
end $test$;
rollback;
