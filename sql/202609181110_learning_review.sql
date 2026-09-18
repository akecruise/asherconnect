-- Phase 11/12: private learning queue and review decisions.
-- Approval deliberately delegates writes to inbox.ah_save so answer lifecycle,
-- versioning, validation and authorization rules remain the single write path.
create or replace function inbox.ah_learning_list(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_role text:=coalesce(core.current_user_role(),''); v_rows jsonb;
begin
  if v_role not in ('manager','admin') then perform answer_hub._fail('ah_not_allowed'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'conversation_id',c.conversation_id,'question',c.question,
    'human_answer',c.human_answer,'project_id',c.project_id,
    'occurrence_count',c.occurrence_count,'quality_score',c.quality_score,
    'status',c.status,'created_at',c.created_at,'updated_at',c.updated_at
  ) order by c.occurrence_count desc,c.created_at desc),'[]'::jsonb) into v_rows
  from answer_hub.learning_candidate c
  where (nullif(p_data->>'status','') is null or c.status=p_data->>'status')
    and (nullif(p_data->>'project_id','') is null or c.project_id=(p_data->>'project_id')::uuid);
  return jsonb_build_object('rows',v_rows);
end $$;

create or replace function inbox.ah_learning_review(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_role text:=coalesce(core.current_user_role(),''); c answer_hub.learning_candidate;
  v_decision text:=lower(coalesce(p_data->>'decision',''));
  v_answer jsonb; v_answer_id uuid; v_examples jsonb;
begin
  if v_role not in ('manager','admin') then perform answer_hub._fail('ah_not_allowed'); end if;
  select * into c from answer_hub.learning_candidate where id=(p_data->>'id')::uuid for update;
  if not found or c.status <> 'pending' then perform answer_hub._fail('ah_state_not_allowed'); end if;
  if v_decision='reject' then
    update answer_hub.learning_candidate set status='rejected',updated_at=now() where id=c.id returning to_jsonb(answer_hub.learning_candidate.*) into v_answer;
    return jsonb_build_object('candidate',v_answer);
  end if;
  if v_decision in ('approve','edit_approve') then
    v_answer := coalesce(p_data->'answer','{}'::jsonb) || jsonb_build_object(
      'title',coalesce(nullif(trim(p_data->'answer'->>'title'),''),left(c.question,200)),
      'body_template',coalesce(nullif(p_data->'answer'->>'body_template',''),c.human_answer),
      'question_examples',coalesce(p_data->'answer'->'question_examples',jsonb_build_array(c.question)),
      'project_id',coalesce(p_data->'answer'->>'project_id',c.project_id::text),
      'source_type','learned','bot_auto_answer',false,'show_in_quick_answer',false,'submit',true,
      'change_reason',coalesce(nullif(trim(p_data->'answer'->>'change_reason'),''),'learning candidate approved')
    );
    v_answer := inbox.ah_save(v_answer);
    v_answer_id := (v_answer->>'id')::uuid;
    update answer_hub.learning_candidate set status='approved',updated_at=now() where id=c.id;
    return jsonb_build_object('candidate',to_jsonb(c)||jsonb_build_object('status','approved'),'answer_id',v_answer_id,'answer',v_answer);
  end if;
  if v_decision='merge' then
    v_answer_id := nullif(p_data->>'answer_id','')::uuid;
    if v_answer_id is null then perform answer_hub._fail('ah_invalid'); end if;
    select coalesce(question_examples,'[]'::jsonb) into v_examples from answer_hub.answer_item where id=v_answer_id;
    if not found then perform answer_hub._fail('ah_not_found'); end if;
    if not (v_examples @> jsonb_build_array(to_jsonb(c.question))) then v_examples:=v_examples||jsonb_build_array(c.question); end if;
    v_answer := inbox.ah_save(jsonb_build_object('id',v_answer_id,'question_examples',v_examples,'submit',true,
      'change_reason','learning candidate merged','bot_auto_answer',false));
    update answer_hub.learning_candidate set status='merged',updated_at=now() where id=c.id;
    return jsonb_build_object('candidate',to_jsonb(c)||jsonb_build_object('status','merged'),'answer_id',v_answer_id,'answer',v_answer);
  end if;
  perform answer_hub._fail('ah_invalid');
end $$;

grant execute on function inbox.ah_learning_list(jsonb), inbox.ah_learning_review(jsonb) to authenticated;
revoke all on function inbox.ah_learning_list(jsonb), inbox.ah_learning_review(jsonb) from public,anon;
notify pgrst,'reload schema';
