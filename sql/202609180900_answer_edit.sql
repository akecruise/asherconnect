-- Answer Hub Phase 9 — additive editor support.
-- Adds a stable human-facing key without changing existing rows or legacy QR.
alter table answer_hub.answer_item
  add column if not exists answer_key text;
alter table answer_hub.answer_item
  add column if not exists question_examples jsonb not null default '[]',
  add column if not exists attachments jsonb not null default '[]',
  add column if not exists source_reference text;

create unique index if not exists answer_item_answer_key_uq
  on answer_hub.answer_item (answer_key)
  where answer_key is not null;

alter table answer_hub.answer_version
  add column if not exists answer_key text;

create or replace function answer_hub._snapshot_version(
  p_item answer_hub.answer_item,
  p_changed_by uuid,
  p_reason text default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_no integer;
begin
  select coalesce(max(version_no), 0) + 1 into v_no
    from answer_hub.answer_version where answer_item_id = p_item.id;
  insert into answer_hub.answer_version
    (answer_item_id, version_no, answer_key, title, body_template, snapshot, changed_by, change_reason)
  values
    (p_item.id, v_no, p_item.answer_key, p_item.title, p_item.body_template,
     to_jsonb(p_item) || jsonb_build_object('bindings', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from answer_hub.answer_data_binding b where b.answer_item_id=p_item.id)), p_changed_by, left(p_reason, 500));
  return v_no;
end $$;

create or replace function inbox.ah_save(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_id uuid := nullif(p_data->>'id', '')::uuid;
  v_reason text := nullif(trim(p_data->>'change_reason'), '');
  v_key text := nullif(lower(trim(p_data->>'answer_key')), '');
  a answer_hub.answer_item;
begin
  if v_role not in ('manager', 'admin') then perform answer_hub._fail('ah_not_allowed'); end if;
  if v_id is null and (coalesce(trim(p_data->>'title'), '') = '' or coalesce(trim(p_data->>'body_template'), '') = '') then
    perform answer_hub._fail('ah_invalid');
  end if;
  if v_key is not null and v_key !~ '^[a-z0-9][a-z0-9_-]{1,79}$' then perform answer_hub._fail('ah_invalid'); end if;
  if v_key is not null and exists (select 1 from answer_hub.answer_item x where x.answer_key = v_key and x.id is distinct from v_id) then
    perform answer_hub._fail('ah_duplicate');
  end if;
  if p_data->>'category_id' is not null and p_data->>'category_id' <> ''
     and not exists (select 1 from answer_hub.answer_category where id = (p_data->>'category_id')::uuid) then perform answer_hub._fail('ah_not_found'); end if;
  if p_data->>'project_id' is not null and p_data->>'project_id' <> ''
     and not exists (select 1 from core.project where id = (p_data->>'project_id')::uuid) then perform answer_hub._fail('ah_not_found'); end if;

  if v_id is null then
    insert into answer_hub.answer_item
      (answer_key, category_id, intent_id, title, body_template, answer_type, audience, source_type,
       project_id, language, status, show_in_quick_answer, bot_auto_answer, priority, confidence,
       valid_from, valid_to, created_by)
    values
      (v_key, nullif(p_data->>'category_id','')::uuid, nullif(p_data->>'intent_id','')::uuid,
       trim(p_data->>'title'), p_data->>'body_template', coalesce(p_data->>'answer_type','static'),
       coalesce(p_data->>'audience','both'), coalesce(p_data->>'source_type','manual'),
       nullif(p_data->>'project_id','')::uuid, coalesce(nullif(trim(p_data->>'language'),''),'th'),
       case when coalesce((p_data->>'submit')::boolean,false) then 'review' else 'draft' end,
       coalesce((p_data->>'show_in_quick_answer')::boolean,true), coalesce((p_data->>'bot_auto_answer')::boolean,false),
       coalesce((p_data->>'priority')::int,100), (p_data->>'confidence')::numeric,
       (p_data->>'valid_from')::timestamptz, (p_data->>'valid_to')::timestamptz, auth.uid())
    returning * into a;
  else
    select * into a from answer_hub.answer_item where id=v_id for update;
    if not found then perform answer_hub._fail('ah_not_found'); end if;
    if a.status='retired' then perform answer_hub._fail('ah_state_not_allowed'); end if;
    if a.status='approved' then perform answer_hub._snapshot_version(a,auth.uid(),v_reason); end if;
    update answer_hub.answer_item set
      answer_key=case when p_data ? 'answer_key' then v_key else a.answer_key end,
      category_id=case when p_data ? 'category_id' then nullif(p_data->>'category_id','')::uuid else a.category_id end,
      intent_id=case when p_data ? 'intent_id' then nullif(p_data->>'intent_id','')::uuid else a.intent_id end,
      title=coalesce(nullif(trim(p_data->>'title'),''),a.title),
      body_template=coalesce(p_data->>'body_template',a.body_template),
      answer_type=coalesce(p_data->>'answer_type',a.answer_type), audience=coalesce(p_data->>'audience',a.audience),
      project_id=case when p_data ? 'project_id' then nullif(p_data->>'project_id','')::uuid else a.project_id end,
      language=coalesce(nullif(trim(p_data->>'language'),''),a.language),
      show_in_quick_answer=coalesce((p_data->>'show_in_quick_answer')::boolean,a.show_in_quick_answer),
      bot_auto_answer=coalesce((p_data->>'bot_auto_answer')::boolean,a.bot_auto_answer),
      priority=coalesce((p_data->>'priority')::int,a.priority), confidence=coalesce((p_data->>'confidence')::numeric,a.confidence),
      valid_from=case when p_data ? 'valid_from' then (p_data->>'valid_from')::timestamptz else a.valid_from end,
      valid_to=case when p_data ? 'valid_to' then (p_data->>'valid_to')::timestamptz else a.valid_to end,
      status=case when a.status='approved' or coalesce((p_data->>'submit')::boolean,false) then 'review' else a.status end,
      approved_by=case when a.status='approved' then null else a.approved_by end,
      approved_at=case when a.status='approved' then null else a.approved_at end
    where id=v_id returning * into a;
  end if;
  if (p_data ? 'title' and coalesce(trim(p_data->>'title'),'')='')
     or (p_data ? 'body_template' and coalesce(trim(p_data->>'body_template'),'')='')
     or (a.valid_from is not null and a.valid_to is not null and a.valid_from > a.valid_to)
     or (a.confidence is not null and (a.confidence < 0 or a.confidence > 1)) then
    perform answer_hub._fail('ah_invalid');
  end if;
  if p_data ? 'question_examples' then
    if jsonb_typeof(p_data->'question_examples') is distinct from 'array' then perform answer_hub._fail('ah_invalid'); end if;
    if exists(select 1 from jsonb_array_elements(p_data->'question_examples') x where jsonb_typeof(x)<>'string') then perform answer_hub._fail('ah_invalid'); end if;
  end if;
  if p_data ? 'attachments' then
    if jsonb_typeof(p_data->'attachments') is distinct from 'array' then perform answer_hub._fail('ah_invalid'); end if;
    if exists(select 1 from jsonb_array_elements(p_data->'attachments') x
      where jsonb_typeof(x)<>'string' or (x #>> '{}') !~ '^https://[^[:space:]]+$') then perform answer_hub._fail('ah_invalid'); end if;
  end if;
  update answer_hub.answer_item set
    question_examples=case when p_data ? 'question_examples' then p_data->'question_examples' else a.question_examples end,
    attachments=case when p_data ? 'attachments' then p_data->'attachments' else a.attachments end,
    source_reference=case when p_data ? 'source_reference' then nullif(trim(p_data->>'source_reference'),'') else a.source_reference end,
    source_type=coalesce(p_data->>'source_type',a.source_type),
    confidence=case when p_data ? 'confidence' then (p_data->>'confidence')::numeric else a.confidence end
  where id=a.id returning * into a;
  -- Bindings are replaced atomically with the item. Failure rolls back the entire save.
  if p_data ? 'bindings' then
    if jsonb_typeof(p_data->'bindings') is distinct from 'array' then perform answer_hub._fail('ah_invalid'); end if;
    if (select count(*) <> count(distinct lower(regexp_replace(x->>'variable_name','\s|\{|\}','','g')))
        from jsonb_array_elements(p_data->'bindings') x) then perform answer_hub._fail('ah_duplicate'); end if;
    delete from answer_hub.answer_data_binding where answer_item_id=a.id;
    perform inbox.ah_binding_save(x || jsonb_build_object('answer_item_id',a.id))
      from jsonb_array_elements(p_data->'bindings') x;
  end if;
  return to_jsonb(a);
exception
  when unique_violation then perform answer_hub._fail('ah_duplicate');
  when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range or datetime_field_overflow then perform answer_hub._fail('ah_invalid');
  when foreign_key_violation then perform answer_hub._fail('ah_not_found');
end $$;

create or replace function inbox.ah_versions(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role text:=coalesce(core.current_user_role(),''); v_rows jsonb;
begin
  if v_role not in ('manager','admin') then perform answer_hub._fail('ah_not_allowed'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'version_no',v.version_no,'answer_key',v.answer_key,'title',v.title,'body_template',v.body_template,
    'changed_by',v.changed_by,'change_reason',v.change_reason,'created_at',v.created_at,'snapshot',v.snapshot
  ) order by v.version_no desc),'[]'::jsonb) into v_rows
  from answer_hub.answer_version v where v.answer_item_id=(p_data->>'id')::uuid;
  return jsonb_build_object('rows',v_rows);
end $$;

grant execute on function inbox.ah_save(jsonb) to authenticated;
grant execute on function inbox.ah_versions(jsonb) to authenticated;
revoke all on function inbox.ah_save(jsonb) from public,anon;
revoke all on function inbox.ah_versions(jsonb) from public,anon;
notify pgrst,'reload schema';

-- Direct binding RPCs must preserve the same lifecycle as the editor's atomic save.
create or replace function answer_hub._binding_edit_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a answer_hub.answer_item; v_id uuid;
begin
  v_id := case when TG_OP='DELETE' then OLD.answer_item_id else NEW.answer_item_id end;
  select * into a from answer_hub.answer_item where id=v_id for update;
  if a.status='retired' then perform answer_hub._fail('ah_state_not_allowed'); end if;
  if a.status='approved' then
    perform answer_hub._snapshot_version(a,auth.uid(),'Binding changed');
    update answer_hub.answer_item set status='review',approved_by=null,approved_at=null where id=v_id;
  end if;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
revoke all on function answer_hub._binding_edit_guard() from public,anon,authenticated,service_role;
create or replace trigger answer_binding_edit_guard before insert or update or delete
on answer_hub.answer_data_binding for each row execute function answer_hub._binding_edit_guard();

create or replace function inbox.ah_editor_options(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(core.current_user_role(),'') not in ('manager','admin') then perform answer_hub._fail('ah_not_allowed'); end if;
  return jsonb_build_object(
    'role', core.current_user_role(),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name_th) order by name_th),'[]') from answer_hub.answer_category),
    'intents', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]') from answer_hub.intent),
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]') from core.project),
    'sources', inbox.ah_source_list('{}')->'rows');
end $$;
grant execute on function inbox.ah_editor_options(jsonb) to authenticated;
revoke all on function inbox.ah_editor_options(jsonb) from public,anon,service_role;

create or replace function inbox.ah_preview_data(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role    text := coalesce(core.current_user_role(), '');
  v_item    answer_hub.answer_item;
  b         record;
  v_vals    jsonb := '{}'::jsonb;
  v_detail  jsonb := '[]'::jsonb;
  v_missing text[] := '{}';
  v_sources text[] := '{}';
  v_res     jsonb;
  v_raw     jsonb;
  v_val     text;
  v_ctx     jsonb;
begin
  if v_role not in ('manager','admin') then perform answer_hub._fail('ah_not_allowed'); end if;
  if jsonb_typeof(coalesce(p_data->'bindings','[]'::jsonb)) <> 'array' then perform answer_hub._fail('ah_invalid'); end if;
  -- Unsaved preview only reads ERP; no temporary answer or history.
  for b in
    select x.variable_name, x.source_field, x.required, x.fallback_text, s.source_code
    from jsonb_to_recordset(coalesce(p_data->'bindings','[]'::jsonb))
      as x(variable_name text, source_id uuid, source_field text, required boolean, fallback_text text)
    left join answer_hub.source_registry s on s.id=x.source_id
    order by x.variable_name
  loop
    -- source_field ของ binding ต้องเดินทางไปถึง dispatcher ด้วย (src_project_fact
    -- ใช้เป็น fact_key) — คุมบริบทอื่นของผู้เรียกไว้ครบด้วย merge
    v_ctx := coalesce(p_data->'context', '{}'::jsonb)
             || jsonb_build_object('source_field', b.source_field);
    v_res := answer_hub.src_resolve(b.source_code, v_ctx, false);
    v_val := null;

    if coalesce(v_res->>'status', '') = 'ok' then
      if jsonb_typeof(v_res->'value') = 'array' then
        -- แหล่งที่คืนหลายแถว (เช่น CURRENT_PROMOTION) — ใช้กุญแจจากแถวแรกที่มีกุญแจนั้น
        select x -> b.source_field into v_raw
        from jsonb_array_elements(v_res->'value') x
        where b.source_field is not null and (x -> b.source_field) is not null
        limit 1;
      else
        -- object: กุญแจที่ผูกไว้ (source_field) ก่อน แล้วค่าแสดงมาตรฐานของ fact
        -- (text → num — fact_key กับกุญแจใน value เป็นคนละหน้าที่ จึงหาตามลำดับ)
        -- ไม่เจอทั้งคู่และไม่ได้ผูกกุญแจ = ยัดของเดิมให้ตัวกรอง scalar ตัดสิน
        v_raw := null;
        if b.source_field is not null then
          v_raw := v_res->'value'->b.source_field;
        end if;
        if v_raw is null then
          v_raw := coalesce(v_res->'value'->'text', v_res->'value'->'num');
        end if;
        if v_raw is null and b.source_field is null then
          v_raw := v_res->'value';
        end if;
      end if;
      -- ยอมรับเฉพาะ scalar — object/array คือ "ค่าไม่พร้อมแสดง" ไม่ใช่ค่าสำหรับลูกค้า
      if jsonb_typeof(v_raw) in ('string', 'number', 'boolean') then
        v_val := v_raw #>> '{}';
      end if;
    end if;

    -- ทะเบียนแหล่งที่ถูกใช้จริง (ไม่ซ้ำ) — ตัว denied/missing ก็นับเพราะ "พยายามใช้"
    if not (v_sources @> array[b.source_code]) then
      v_sources := v_sources || b.source_code;
    end if;

    if coalesce(v_val, '') <> '' then
      v_vals := v_vals || jsonb_build_object(b.variable_name, v_val);
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'ok', 'value', v_val));
    elsif b.fallback_text is not null then
      v_vals := v_vals || jsonb_build_object(b.variable_name, b.fallback_text);
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'fallback', 'reason', v_res->>'reason'));
    elsif b.required then
      v_missing := v_missing || b.variable_name;
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'missing', 'reason', coalesce(v_res->>'reason', 'no_value')));
    else
      -- optional ขาดและไม่มี fallback → แทนด้วยค่าว่างตอน render
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'missing', 'reason', coalesce(v_res->>'reason', 'no_value')));
    end if;
  end loop;

  return jsonb_build_object(
    'answer_id', v_item.id,
    'status', v_item.status,
    'values', v_vals,
    'missing', to_jsonb(v_missing),
    'sources', to_jsonb(v_sources),
    'ok', (array_length(v_missing, 1) is null),
    'detail', v_detail);
end $$;


grant execute on function inbox.ah_preview_data(jsonb) to authenticated;
revoke all on function inbox.ah_preview_data(jsonb) from public,anon,service_role;
notify pgrst,'reload schema';
