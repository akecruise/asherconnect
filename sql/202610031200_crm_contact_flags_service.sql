-- CRM service access to Connect-owned contact stars and tags.
-- The CRM is a client of this data; this migration deliberately creates no parallel CRM tables.
begin;

create or replace function inbox.service_contact_flags(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_ref uuid := nullif(p->>'contact_ref', '')::uuid;
begin
  if v_ref is null or not exists (select 1 from core.contact where id = v_ref) then
    raise exception 'contact_not_found' using errcode = '42704';
  end if;
  return jsonb_build_object(
    'contact_ref', v_ref,
    'starred', coalesce((select f.starred from connect_private.contact_flag f where f.contact_id = v_ref), false),
    'follow_note', (select f.follow_note from connect_private.contact_flag f where f.contact_id = v_ref),
    'tags', inbox.flag_tags_of(v_ref));
end $$;

create or replace function inbox.service_contact_tags(p jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color,
                                               'sort_order', t.sort_order)
                            order by t.sort_order, t.name), '[]'::jsonb)
    from connect_private.tag t where t.is_active
$$;

create or replace function inbox.service_contact_star(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := nullif(p->>'contact_ref', '')::uuid;
        v_actor uuid := nullif(p->>'actor_id', '')::uuid;
        v_on boolean;
begin
  if v_ref is null or not exists (select 1 from core.contact where id = v_ref) then
    raise exception 'contact_not_found' using errcode = '42704';
  end if;
  if jsonb_typeof(p->'starred') is distinct from 'boolean' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  v_on := (p->>'starred')::boolean;
  insert into connect_private.contact_flag(contact_id, starred, starred_by, starred_at)
  values (v_ref, v_on, case when v_on then v_actor end, case when v_on then now() end)
  on conflict (contact_id) do update
    set starred = excluded.starred, starred_by = excluded.starred_by,
        starred_at = excluded.starred_at, updated_at = now();
  insert into connect_private.audit(actor_id, action, detail)
  values (v_actor, case when v_on then 'crm_star' else 'crm_unstar' end,
          jsonb_build_object('contact_id', v_ref, 'source', 'asher-crm'));
  return inbox.service_contact_flags(jsonb_build_object('contact_ref', v_ref));
end $$;

create or replace function inbox.service_contact_follow_note(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := nullif(p->>'contact_ref', '')::uuid;
        v_actor uuid := nullif(p->>'actor_id', '')::uuid;
        v_note text := nullif(btrim(coalesce(p->>'follow_note', '')), '');
begin
  if v_ref is null or not exists (select 1 from core.contact where id = v_ref) then
    raise exception 'contact_not_found' using errcode = '42704';
  end if;
  if char_length(v_note) > 500 then raise exception 'invalid_note' using errcode = '22023'; end if;
  insert into connect_private.contact_flag(contact_id, follow_note)
  values (v_ref, v_note)
  on conflict (contact_id) do update set follow_note = excluded.follow_note, updated_at = now();
  insert into connect_private.audit(actor_id, action, detail)
  values (v_actor, 'crm_follow_note', jsonb_build_object('contact_id', v_ref, 'source', 'asher-crm'));
  return inbox.service_contact_flags(jsonb_build_object('contact_ref', v_ref));
end $$;

create or replace function inbox.service_contact_tags_set(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := nullif(p->>'contact_ref', '')::uuid;
        v_actor uuid := nullif(p->>'actor_id', '')::uuid;
        v_add uuid[]; v_remove uuid[];
begin
  if v_ref is null or not exists (select 1 from core.contact where id = v_ref) then
    raise exception 'contact_not_found' using errcode = '42704';
  end if;
  select coalesce(array_agg(x::uuid), '{}') into v_add
    from jsonb_array_elements_text(case when jsonb_typeof(p->'add') = 'array' then p->'add' else '[]' end) x;
  select coalesce(array_agg(x::uuid), '{}') into v_remove
    from jsonb_array_elements_text(case when jsonb_typeof(p->'remove') = 'array' then p->'remove' else '[]' end) x;
  if cardinality(v_add) + cardinality(v_remove) > 50 then raise exception 'too_many_tags'; end if;
  delete from connect_private.contact_tag where contact_id = v_ref and tag_id = any(v_remove);
  insert into connect_private.contact_tag(contact_id, tag_id, tagged_by)
  select v_ref, t.id, v_actor from connect_private.tag t
   where t.id = any(v_add) and t.is_active and not (t.id = any(v_remove))
  on conflict do nothing;
  insert into connect_private.audit(actor_id, action, detail)
  values (v_actor, 'crm_tags_set', jsonb_build_object('contact_id', v_ref,
          'added', to_jsonb(v_add), 'removed', to_jsonb(v_remove), 'source', 'asher-crm'));
  return inbox.service_contact_flags(jsonb_build_object('contact_ref', v_ref));
end $$;

revoke all on function inbox.service_contact_flags(jsonb), inbox.service_contact_tags(jsonb),
  inbox.service_contact_star(jsonb), inbox.service_contact_follow_note(jsonb), inbox.service_contact_tags_set(jsonb)
  from public, anon, authenticated;
grant execute on function inbox.service_contact_flags(jsonb), inbox.service_contact_tags(jsonb),
  inbox.service_contact_star(jsonb), inbox.service_contact_follow_note(jsonb), inbox.service_contact_tags_set(jsonb) to service_role;
commit;
