-- Phase 11/12: candidate capture is worker-only; review is manager/admin-only.
do $guard$ begin
  if current_setting('asher.allow_db_tests',true) is distinct from '1' then raise exception 'set asher.allow_db_tests=1'; end if;
end $guard$;
begin;
do $test$
declare v_admin uuid; v_manager uuid; v_sales uuid; v_conversation uuid; v_candidate uuid; v_answer uuid; v_result jsonb; v_denied boolean:=false;
begin
  select user_id into v_admin from core.profile where role='admin' and is_active limit 1;
  select user_id into v_manager from core.profile where role='manager' and is_active limit 1;
  select user_id into v_sales from core.profile where role='sales' and is_active limit 1;
  select c.id into v_conversation from inbox.conversation c
    where exists(select 1 from inbox.message m where m.conversation_id=c.id and m.sender_type='contact')
      and exists(select 1 from inbox.message m where m.conversation_id=c.id and m.sender_type='agent') limit 1;
  if v_conversation is null then raise exception 'fixture conversation with contact/agent messages is required'; end if;
  -- service-role capture creates then deduplicates the exact learned pair.
  execute 'set local role service_role';
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  v_result:=inbox.ah_learning_create(jsonb_build_object('conversation_id',v_conversation));
  v_candidate:=(v_result->>'id')::uuid;
  perform inbox.ah_learning_create(jsonb_build_object('conversation_id',v_conversation));
  reset role;
  if v_candidate is null or (select occurrence_count from answer_hub.learning_candidate where id=v_candidate) < 2 then raise exception 'capture/dedupe failed'; end if;
  -- A normal authenticated sales session cannot invoke worker capture or review.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_sales)::text,true); set local role authenticated;
  begin perform inbox.ah_learning_create(jsonb_build_object('conversation_id',v_conversation)); exception when others then v_denied:=true; end;
  if not v_denied then raise exception 'authenticated capture unexpectedly allowed'; end if;
  v_denied:=false;
  begin perform inbox.ah_learning_list('{}'); exception when others then v_denied:=true; end;
  if not v_denied then raise exception 'sales queue unexpectedly allowed'; end if;
  -- Manager can list and reject. Reject never mutates an answer item.
  reset role; perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager)::text,true); set local role authenticated;
  if not (inbox.ah_learning_list('{}')->'rows' @> jsonb_build_array(jsonb_build_object('id',v_candidate))) then raise exception 'manager list missing candidate'; end if;
  v_result:=inbox.ah_learning_review(jsonb_build_object('id',v_candidate,'decision','reject'));
  if v_result->'candidate'->>'status' <> 'rejected' then raise exception 'reject failed'; end if;
  -- Reopen only inside this rolled-back fixture to prove approve delegates to ah_save.
  reset role; update answer_hub.learning_candidate set status='pending' where id=v_candidate;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager)::text,true); set local role authenticated;
  v_result:=inbox.ah_learning_review(jsonb_build_object('id',v_candidate,'decision','approve','answer',jsonb_build_object('title','[__selftest__] learned','body_template','review me')));
  v_answer:=(v_result->>'answer_id')::uuid;
  reset role;
  if v_answer is null or (select status from answer_hub.answer_item where id=v_answer) <> 'review'
     or (select bot_auto_answer from answer_hub.answer_item where id=v_answer) then raise exception 'approve did not use safe review lifecycle'; end if;
  -- Merge reuses ah_save too, preserving the target's review lifecycle and disabling bot automation.
  update answer_hub.learning_candidate set status='pending' where id=v_candidate;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_manager)::text,true); set local role authenticated;
  v_result:=inbox.ah_learning_review(jsonb_build_object('id',v_candidate,'decision','merge','answer_id',v_answer));
  reset role;
  if v_result->'candidate'->>'status' <> 'merged'
     or not ((select question_examples from answer_hub.answer_item where id=v_answer) @> jsonb_build_array(to_jsonb((select question from answer_hub.learning_candidate where id=v_candidate)))) then raise exception 'merge did not preserve question history'; end if;
end $test$;
rollback;
