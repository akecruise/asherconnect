-- Node -> DB -> CRM contact contract; appended migration, no historical edits.
-- Guarded patches preserve installed receiver/worker fixes; fail on contract drift.
begin;
create or replace function connect_private.apply_contact_signal(p_contact uuid, p_data jsonb, p_now timestamptz)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_name text := nullif(btrim(p_data->>'extracted_name'), '');
  v_phone text := nullif(btrim(p_data->>'extracted_phone'), '');
begin
  if p_data->>'event_type' is distinct from 'message'
     or p_data->>'source_type' is distinct from 'user' then return; end if;
  if length(v_name) > 80 then v_name := null; end if;
  if v_phone !~ '^0[689][0-9]{8}$' then v_phone := null; end if;
  -- Existing/manual values win. Never restore anonymized contacts.
  update core.contact c
     set display_name = case when nullif(btrim(c.display_name), '') is null
                                  and coalesce(c.extra->>'name_source','') <> 'manual'
                             then coalesce(v_name,c.display_name) else c.display_name end,
         phone = coalesce(nullif(btrim(c.phone), ''), v_phone),
         extra = coalesce(c.extra,'{}'::jsonb)
           || case when nullif(btrim(c.display_name), '') is null and v_name is not null
                        and coalesce(c.extra->>'name_source','') <> 'manual'
                   then jsonb_build_object('name_source','customer') else '{}'::jsonb end
           || case when nullif(btrim(c.phone), '') is null and v_phone is not null
                   then jsonb_build_object('phone_source','customer') else '{}'::jsonb end,
         updated_at = p_now
   where c.id = p_contact and c.anonymized_at is null
     and ((nullif(btrim(c.display_name), '') is null and v_name is not null
           and coalesce(c.extra->>'name_source','') <> 'manual')
       or (nullif(btrim(c.phone), '') is null and v_phone is not null));
end $$;
revoke all on function connect_private.apply_contact_signal(uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function connect_private.apply_contact_signal(uuid,jsonb,timestamptz) to service_role;
-- Patch the installed receiver rather than reverting later Instagram/echo fixes.
DO $migration$
DECLARE body text; marker text := '  v_lead := connect_private.ensure_lead(v_id);';
BEGIN
  body := pg_get_functiondef('connect_private.receive_event(jsonb,timestamptz,integer)'::regprocedure);
  IF position('connect_private.apply_contact_signal(v_contact, p_data, p_now)' in body) = 0 THEN
    IF position(marker in body) = 0
       OR position('customer_conversation_ambiguous' in body) = 0 THEN
      RAISE EXCEPTION 'contact_receiver_contract_changed';
    END IF;
    body := replace(body, marker, $patch$
  -- Enrich after identity/conversation validation and before message snapshots.
  if v_event_type = 'message' and p_data->>'source_type' = 'user' then
    perform connect_private.apply_contact_signal(v_contact, p_data, p_now);
  end if;
$patch$ || marker);
    EXECUTE body;
  END IF;
END $migration$;



create or replace function inbox.sync_contact_profile(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_channel text := p_data->>'channel';
  v_person  jsonb;
  v_name    text;
  v_email   text;
  v_contact uuid;
  v_named   int := 0;   -- เติมชื่อที่ยังว่างอยู่
  v_kept    int := 0;   -- มีชื่ออยู่แล้ว เก็บของเดิมไว้
  v_unknown int := 0;   -- ยังไม่เคยคุยผ่านระบบนี้ จึงไม่มีแถวให้เติม
  v_skipped int := 0;   -- ขอลบข้อมูลไปแล้ว ห้ามแตะ
begin
  if coalesce(v_channel,'') = '' then raise exception 'invalid_request'; end if;
  if nullif(btrim(p_data->>'account_key'), '') is null then
    raise exception 'account_scope_required';
  end if;
  if not exists (select 1 from inbox.inbox i
                  where i.id::text = p_data->>'account_key' and i.channel = v_channel) then
    raise exception 'invalid_account_scope';
  end if;

  for v_person in select * from jsonb_array_elements(coalesce(p_data->'people','[]'::jsonb)) loop
    v_name  := nullif(btrim(coalesce(v_person->>'name','')), '');
    v_email := nullif(btrim(coalesce(v_person->>'email','')), '');

    select ci.contact_id into v_contact
      from core.contact_identity ci
     where ci.channel = v_channel and ci.account_key = p_data->>'account_key'
       and ci.external_id = v_person->>'external_id'
     limit 1;
    if v_contact is null then v_unknown := v_unknown + 1; continue; end if;
    if exists (select 1 from core.contact c where c.id = v_contact and c.anonymized_at is not null) then
      v_skipped := v_skipped + 1; continue;
    end if;
    update core.contact c
       set extra = c.extra || jsonb_strip_nulls(jsonb_build_object(
                     'fb_name', v_name, 'fb_email', v_email,
                     'fb_synced_at', to_jsonb(now()))),
           display_name = coalesce(nullif(btrim(c.display_name),''), v_name),
           email        = coalesce(c.email, v_email),
           updated_at   = now()
     where c.id = v_contact and c.anonymized_at is null;

    if exists (select 1 from core.contact c
                where c.id = v_contact and btrim(coalesce(c.display_name,'')) = coalesce(v_name,''))
       and v_name is not null then
      v_named := v_named + 1;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;

  return jsonb_build_object('named', v_named, 'kept', v_kept,
                            'unknown', v_unknown, 'skipped', v_skipped);
end $$;
revoke all on function inbox.sync_contact_profile(jsonb) from public, anon, authenticated;
grant execute on function inbox.sync_contact_profile(jsonb) to service_role;

comment on function inbox.sync_contact_profile(jsonb) is
  'เติมชื่อ/อีเมลจาก participants ของกล่องข้อความเพจ — เขียน display_name เฉพาะตอนที่ยังว่าง';
CREATE OR REPLACE FUNCTION inbox.crm_publish_profile_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, inbox, core
AS $$
DECLARE
  v_identity core.contact_identity;
  v_event_id uuid;
BEGIN
  IF NEW.anonymized_at IS NOT NULL THEN RETURN NEW; END IF;
  IF coalesce(NEW.extra->>'name_source', '') = 'manual' AND OLD.phone IS NOT DISTINCT FROM NEW.phone THEN
    RETURN NEW;
  END IF;
  IF OLD.phone IS NOT DISTINCT FROM NEW.phone
     AND OLD.display_name IS NOT DISTINCT FROM NEW.display_name
     AND OLD.picture_url IS NOT DISTINCT FROM NEW.picture_url
     AND OLD.profile_status IS NOT DISTINCT FROM NEW.profile_status THEN
    RETURN NEW;
  END IF;

  FOR v_identity IN
    SELECT * FROM core.contact_identity
     WHERE contact_id = NEW.id AND channel IN ('line', 'messenger')
  LOOP
    v_event_id := md5('contact.profile_updated:' || NEW.id::text || ':' || v_identity.id::text || ':' || coalesce(NEW.updated_at::text, '') || ':' || jsonb_build_array(NEW.display_name, NEW.phone, NEW.picture_url, NEW.profile_status)::text)::uuid;
    INSERT INTO inbox.crm_publish_outbox
      (event_id, event_type, aggregate_type, aggregate_id, occurred_at, payload)
    VALUES
      (v_event_id, 'contact.profile_updated', 'contact', NEW.id::text,
       coalesce(NEW.updated_at, now()),
       jsonb_build_object(
         'provider', v_identity.channel,
         'account_scope', v_identity.account_key,
         'external_id', v_identity.external_id,
         'display_name', NEW.display_name,
         'phone', NEW.phone,
         'picture_url', NEW.picture_url,
         'status', NEW.profile_status))
    ON CONFLICT (event_id) DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_crm_publish_profile_updated ON core.contact;
CREATE TRIGGER trg_crm_publish_profile_updated
  AFTER UPDATE OF display_name, phone, picture_url, profile_status ON core.contact
  FOR EACH ROW EXECUTE FUNCTION inbox.crm_publish_profile_updated();

create or replace function inbox.crm_publish_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, inbox, core as $$
declare
  v_inbox inbox.inbox;
  v_conversation inbox.conversation;
  v_identity core.contact_identity;
  v_contact core.contact;
  v_profile jsonb;
  v_sender_kind text;
  v_event_type text;
  v_event_id uuid;
  v_payload jsonb;
  v_conv_event_id uuid;
begin
  if NEW.sender_type not in ('contact', 'agent', 'bot') then
    return NEW;
  end if;

  select * into v_conversation from inbox.conversation where id = NEW.conversation_id;
  if not found then return NEW; end if;
  select * into v_inbox from inbox.inbox where id = v_conversation.inbox_id;
  if not found or v_inbox.channel not in ('line', 'messenger') then return NEW; end if;

  select * into v_identity
    from core.contact_identity
   where contact_id = v_conversation.contact_id
     and channel = v_inbox.channel
     and account_key = v_inbox.id::text
   order by id
   limit 1;
  if v_identity.external_id is null then
    return NEW;
  end if;
  select * into v_contact from core.contact where id = v_conversation.contact_id;
  v_profile := jsonb_build_object(
    'display_name', v_contact.display_name,
    'phone', v_contact.phone,
    'picture_url', v_contact.picture_url,
    'status', v_contact.profile_status
  );
  v_conv_event_id := md5('conversation.created:' || v_conversation.id::text)::uuid;
  insert into inbox.crm_publish_outbox
    (event_id, event_type, aggregate_id, occurred_at, payload)
  values (
    v_conv_event_id,
    'conversation.created',
    v_conversation.id::text,
    coalesce(v_conversation.created_at, NEW.created_at),
    jsonb_build_object(
      'conversation_id', v_conversation.id::text,
      'provider', v_inbox.channel,
      'account_scope', v_inbox.id::text,
      'external_id', v_identity.external_id
    ) || v_profile
  )
  on conflict (event_id) do nothing;
  v_sender_kind := case NEW.sender_type when 'contact' then 'customer' when 'agent' then 'human' else 'bot' end;
  v_event_type := case NEW.sender_type when 'contact' then 'message.received' else 'message.sent' end;
  v_event_id := NEW.id;
  v_payload := jsonb_build_object(
    'conversation_id', NEW.conversation_id::text,
    'provider', v_inbox.channel,
    'account_scope', v_inbox.id::text,
    'external_id', v_identity.external_id,
    'message_id', NEW.id::text,
    'sender_kind', v_sender_kind,
    'sender_id', case when NEW.sender_id is null then null else NEW.sender_id::text end,
    'agent_id', case when NEW.sender_type = 'agent' and NEW.sender_id is not null then NEW.sender_id::text else null end,
    'content', NEW.content
  ) || v_profile;

  insert into inbox.crm_publish_outbox
    (event_id, event_type, aggregate_id, occurred_at, payload)
  values (v_event_id, v_event_type, NEW.conversation_id::text, NEW.created_at, v_payload)
  on conflict (event_id) do nothing;
  return NEW;
exception when others then
  return NEW;
end $$;
-- Retain every installed worker branch; protect customer-supplied names too.
DO $migration$
DECLARE body text;
BEGIN
  body := pg_get_functiondef('connect_private.worker(text,jsonb)'::regprocedure);
  IF position('contact_signal_name_guard' in body) = 0 THEN
    IF position('coalesce(ct.extra->>''name_source'','''') = ''manual''' in body) = 0
       OR position('where ct.id = v_contact;' in body) = 0 THEN
      RAISE EXCEPTION 'contact_worker_contract_changed';
    END IF;
    body := replace(body, 'coalesce(ct.extra->>''name_source'','''') = ''manual''',
      'coalesce(ct.extra->>''name_source'','''') in (''manual'',''customer'') /* contact_signal_name_guard */');
    body := replace(body, 'where ct.id = v_contact;',
      'where ct.id = v_contact and ct.anonymized_at is null;');
    EXECUTE body;
  END IF;
END $migration$;
revoke all on function connect_private.receive_event(jsonb,timestamptz,int) from public,anon,authenticated;
grant execute on function connect_private.receive_event(jsonb,timestamptz,int) to service_role;
revoke all on function inbox.crm_publish_profile_updated() from public,anon,authenticated;
revoke all on function inbox.crm_publish_message() from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
