-- Phase 20 MVP: Answer Hub health summary for authenticated managers/admins.
create or replace function inbox.ah_health(p_data jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_role text:=coalesce(core.current_user_role(),''); v_total int; v_approved int; v_draft int; v_review int; v_learning int; v_usage int; v_feedback int;
begin
 if v_role not in ('manager','admin') then perform answer_hub._fail('ah_not_allowed'); end if;
 select count(*) filter(where true),count(*) filter(where status='approved'),count(*) filter(where status='draft'),count(*) filter(where status='review') into v_total,v_approved,v_draft,v_review from answer_hub.answer_item;
 select count(*) into v_learning from answer_hub.learning_candidate where status='pending'; select count(*) into v_usage from answer_hub.answer_usage where used_at>=now()-interval '1 day'; select count(*) into v_feedback from answer_hub.answer_feedback where created_at>=now()-interval '1 day';
 return jsonb_build_object('answers_total',v_total,'approved',v_approved,'draft',v_draft,'review',v_review,'learning_pending',v_learning,'usage_today',v_usage,'feedback_today',v_feedback,'checked_at',now());
end $$;
grant execute on function inbox.ah_health(jsonb) to authenticated;
revoke all on function inbox.ah_health(jsonb) from public,anon;
notify pgrst,'reload schema';
