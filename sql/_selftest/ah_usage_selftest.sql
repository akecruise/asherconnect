-- Phase 16 MVP usage authorization and post-success contract.
do $guard$ begin if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'set asher.allow_db_tests=1'; end if; end $guard$;
begin;
do $test$
declare v_answer uuid; v_sales uuid; v_conv uuid; r jsonb; denied boolean:=false; before_count int; after_count int;
begin
 select id into v_answer from answer_hub.answer_item where status='approved' limit 1;
 if v_answer is null then insert into answer_hub.answer_item(title,body_template,status,audience,show_in_quick_answer) values ('[__selftest__] usage','usage fixture','approved','human',true) returning id into v_answer; end if;
 select user_id into v_sales from core.profile where role='sales' and is_active limit 1; select id into v_conv from inbox.conversation limit 1;
 select count(*) into before_count from answer_hub.answer_usage;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true); set local role service_role;
 r:=inbox.ah_usage_record(jsonb_build_object('answer_id',v_answer,'conversation_id',v_conv,'channel','test')); if r->>'ok' <> 'true' then raise exception 'service usage failed'; end if;
 reset role; perform set_config('request.jwt.claims',jsonb_build_object('sub',v_sales)::text,true); set local role authenticated;
 begin perform inbox.ah_usage_record(jsonb_build_object('answer_id',v_answer)); exception when others then denied:=true; end;
 if not denied then raise exception 'authenticated usage unexpectedly allowed'; end if;
 reset role; select count(*) into after_count from answer_hub.answer_usage; if after_count <> before_count+1 then raise exception 'usage count mismatch'; end if;
end $test$;
rollback;
