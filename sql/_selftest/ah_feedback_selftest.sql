-- Phase 17 MVP feedback authorization and insert.
do $guard$ begin if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'set asher.allow_db_tests=1'; end if; end $guard$;
begin;
do $test$
declare v_answer uuid; v_sales uuid; r jsonb; denied boolean:=false;
begin
 select id into v_answer from answer_hub.answer_item where status='approved' limit 1; if v_answer is null then insert into answer_hub.answer_item(title,body_template,status,audience,show_in_quick_answer) values('[__selftest__] feedback','feedback fixture','approved','human',true) returning id into v_answer; end if; select user_id into v_sales from core.profile where role='sales' and is_active limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_sales)::text,true); set local role authenticated;
 r:=inbox.ah_feedback(jsonb_build_object('answer_id',v_answer,'kind','incorrect','note','mvp test')); if r->>'id' is null then raise exception 'feedback insert failed'; end if;
 reset role; perform set_config('request.jwt.claims','{}',true); set local role authenticated;
 begin perform inbox.ah_feedback(jsonb_build_object('answer_id',v_answer)); exception when others then denied:=true; end; if not denied then raise exception 'anonymous feedback unexpectedly allowed'; end if;
end $test$;
rollback;
