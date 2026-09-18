-- Phase 10: audit-only batches. Preview never writes; apply uses inbox.ah_save.
create table if not exists answer_hub.import_batch (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  rows jsonb not null check (jsonb_typeof(rows)='array'),
  result jsonb not null check (jsonb_typeof(result)='object')
);
alter table answer_hub.import_batch enable row level security;
revoke all on answer_hub.import_batch from public, anon, authenticated;

create or replace function answer_hub._import_row(p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c uuid; i uuid; pr uuid; existing uuid; kind text;
begin
  if coalesce(trim(p->>'title'),'')='' or coalesce(p->>'body_template','')='' then perform answer_hub._fail('ah_invalid_import_row'); end if;
  select id into c from answer_hub.answer_category where code=lower(trim(p->>'category'));
  if c is null then perform answer_hub._fail('ah_invalid_import_row'); end if;
  if nullif(p->>'intent','') is not null then select id into i from answer_hub.intent where code=lower(trim(p->>'intent')); if i is null then perform answer_hub._fail('ah_invalid_import_row'); end if; end if;
  if nullif(p->>'project','') is not null then select id into pr from core.project where code=trim(p->>'project'); if pr is null then perform answer_hub._fail('ah_invalid_import_row'); end if; end if;
  select id into existing from answer_hub.answer_item where answer_key=nullif(lower(trim(p->>'answer_key')),'')
    or (answer_key is null and title=trim(p->>'title') and project_id is not distinct from pr) limit 1;
  kind:=case when existing is null then 'NEW' else 'UPDATE' end;
  return p || jsonb_build_object('category_id',c,'intent_id',i,'project_id',pr,'id',existing,'classification',kind,'source_type','imported');
end $$;

create or replace function inbox.ah_import_preview(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; normalized jsonb;
begin
  if coalesce(core.current_user_role(),'') <> 'admin' then perform answer_hub._fail('ah_not_allowed'); end if;
  rows:=p_data->'rows'; if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)>500 then perform answer_hub._fail('ah_invalid_import_row'); end if;
  select coalesce(jsonb_agg(answer_hub._import_row(x)),'[]'::jsonb) into normalized from jsonb_array_elements(rows) x;
  return jsonb_build_object('rows',normalized,'new',(select count(*) from jsonb_array_elements(normalized) x where x->>'classification'='NEW'),'update',(select count(*) from jsonb_array_elements(normalized) x where x->>'classification'='UPDATE'));
end $$;

create or replace function inbox.ah_import_commit(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare rows jsonb; r jsonb; saved jsonb; out jsonb:='[]'::jsonb; bid uuid; n int:=0;
begin
  if coalesce(core.current_user_role(),'') <> 'admin' then perform answer_hub._fail('ah_not_allowed'); end if;
  rows:=inbox.ah_import_preview(jsonb_build_object('rows',p_data->'rows'))->'rows';
  for r in select value from jsonb_array_elements(rows) loop
    saved:=inbox.ah_save(r || jsonb_build_object('submit',coalesce((p_data->>'submit')::boolean,false)));
    out:=out||jsonb_build_array(jsonb_build_object('row',r->>'_row','classification',r->>'classification','answer',saved)); n:=n+1;
  end loop;
  insert into answer_hub.import_batch(created_by,rows,result) values(auth.uid(),rows,jsonb_build_object('rows',out,'count',n)) returning id into bid;
  return jsonb_build_object('batch_id',bid,'count',n,'rows',out);
end $$;
grant execute on function inbox.ah_import_preview(jsonb) to authenticated;
grant execute on function inbox.ah_import_commit(jsonb) to authenticated;
revoke all on function inbox.ah_import_preview(jsonb), inbox.ah_import_commit(jsonb) from public, anon, service_role;
notify pgrst,'reload schema';
