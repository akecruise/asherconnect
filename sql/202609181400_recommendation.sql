-- Phase 14: SQL-first recommendation over the approved Answer Hub corpus.
create extension if not exists pg_trgm;
create index if not exists answer_item_recommend_fts_idx on answer_hub.answer_item using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body_template,'')));
create index if not exists answer_item_recommend_trgm_idx on answer_hub.answer_item using gin (title gin_trgm_ops);
create or replace function inbox.ah_recommend(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_role text:=coalesce(core.current_user_role(),''); v_question text:=nullif(trim(p_data->>'question'),''); v_project uuid; v_audience text:=coalesce(nullif(p_data->>'audience',''),'human'); v_rows jsonb;
begin
 if v_role='' then perform answer_hub._fail('ah_not_allowed'); end if;
 if jsonb_typeof(p_data)<>'object' or length(coalesce(v_question,'')) > 500 or v_audience not in ('human','bot') then perform answer_hub._fail('ah_invalid'); end if;
 if coalesce(p_data->>'project_id','')<>'' then
   if p_data->>'project_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform answer_hub._fail('ah_invalid'); end if;
   v_project:=(p_data->>'project_id')::uuid;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'body_template',x.body_template,'answer_type',x.answer_type,'score',x.score,'reasons',x.reasons,'category_id',x.category_id,'attachments',x.attachments) order by x.score desc,x.priority,x.updated_at desc),'[]'::jsonb) into v_rows
 from (select a.*, (case when v_question is null then 0 else public.similarity(lower(a.title),lower(v_question))*4 + ts_rank_cd(to_tsvector('simple',coalesce(a.title,'')||' '||coalesce(a.body_template,'')), plainto_tsquery('simple',v_question))*3 + case when lower(a.title||' '||a.body_template) like '%'||lower(v_question)||'%' then 2 else 0 end end + case when a.project_id=v_project then 1 else 0 end - a.priority::numeric/1000) score,
   jsonb_strip_nulls(jsonb_build_array(case when v_question is not null then 'keyword' end,case when a.project_id=v_project then 'project' end,'priority')) reasons
   from answer_hub.answer_item a where a.status='approved' and a.audience in (case when v_audience='bot' then 'bot' else 'human' end,'both') and (v_audience='bot' or a.show_in_quick_answer) and (v_audience<>'bot' or a.bot_auto_answer) and (v_project is null or a.project_id is null or a.project_id=v_project)
   order by score desc,a.priority,a.updated_at desc limit 10) x;
 return jsonb_build_object('rows',v_rows);
end $$;
grant execute on function inbox.ah_recommend(jsonb) to authenticated;
revoke all on function inbox.ah_recommend(jsonb) from public,anon;
notify pgrst,'reload schema';
