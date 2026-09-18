-- Phase 13: sales-facing picker. This deliberately exposes only approved,
-- human-usable answers and never writes or sends a message.
create or replace function inbox.ah_quick_answer(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_role text:=coalesce(core.current_user_role(),''); v_query text:=nullif(trim(p_data->>'query'),''); v_project uuid; v_category uuid; v_rows jsonb; v_categories jsonb;
begin
  if v_role='' then perform answer_hub._fail('ah_not_allowed'); end if;
  if jsonb_typeof(p_data) <> 'object' or length(coalesce(v_query,'')) > 200 then perform answer_hub._fail('ah_invalid'); end if;
  if coalesce(p_data->>'project_id','') <> '' then
    if p_data->>'project_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform answer_hub._fail('ah_invalid'); end if;
    v_project := (p_data->>'project_id')::uuid;
  end if;
  if coalesce(p_data->>'category_id','') <> '' then
    if p_data->>'category_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform answer_hub._fail('ah_invalid'); end if;
    v_category := (p_data->>'category_id')::uuid;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'body_template',a.body_template,
    'category_id',a.category_id,'category',c.name_th,'project_id',a.project_id,'answer_type',a.answer_type,
    'attachments',a.attachments,'priority',a.priority) order by a.priority,a.updated_at desc),'[]'::jsonb) into v_rows
  from (select a.* from answer_hub.answer_item a where a.status='approved' and a.show_in_quick_answer
    and a.audience in ('human','both') and (v_project is null or a.project_id is null or a.project_id=v_project)
    and (v_category is null or a.category_id=v_category)
    and (v_query is null or a.title ilike '%'||replace(replace(v_query,'\\','\\\\'),'%','\\%')||'%'
      or a.body_template ilike '%'||replace(replace(v_query,'\\','\\\\'),'%','\\%')||'%')
    order by a.priority,a.updated_at desc limit 30) a left join answer_hub.answer_category c on c.id=a.category_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name_th) order by c.sort_order,c.name_th),'[]'::jsonb) into v_categories
  from answer_hub.answer_category c where exists(select 1 from answer_hub.answer_item a where a.category_id=c.id and a.status='approved' and a.show_in_quick_answer and a.audience in ('human','both'));
  return jsonb_build_object('rows',v_rows,'categories',v_categories);
end $$;
grant execute on function inbox.ah_quick_answer(jsonb) to authenticated;
revoke all on function inbox.ah_quick_answer(jsonb) from public,anon;
notify pgrst,'reload schema';
