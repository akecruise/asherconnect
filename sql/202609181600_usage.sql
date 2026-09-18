-- Phase 16 MVP: append-only usage audit, written only through a service-role RPC.
create table if not exists answer_hub.answer_usage (
 id uuid primary key default gen_random_uuid(), answer_item_id uuid not null references answer_hub.answer_item(id), user_id uuid, conversation_id uuid references inbox.conversation(id), channel text, used_at timestamptz not null default now(), metadata jsonb not null default '{}'::jsonb
);
create index if not exists answer_usage_answer_used_idx on answer_hub.answer_usage(answer_item_id, used_at desc);
alter table answer_hub.answer_usage enable row level security;
revoke all on answer_hub.answer_usage from public, anon, authenticated;
create or replace function inbox.ah_usage_record(p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text:=coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role',''); v_answer uuid; v_conversation uuid;
begin
 if v_role<>'service_role' then perform answer_hub._fail('ah_not_allowed'); end if;
 if p_data->>'answer_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform answer_hub._fail('ah_invalid'); end if;
 v_answer:=(p_data->>'answer_id')::uuid; if not exists (select 1 from answer_hub.answer_item where id=v_answer and status='approved') then perform answer_hub._fail('ah_not_found'); end if;
 if coalesce(p_data->>'conversation_id','')<>'' then v_conversation:=(p_data->>'conversation_id')::uuid; end if;
 insert into answer_hub.answer_usage(answer_item_id,user_id,conversation_id,channel,metadata) values(v_answer,nullif(p_data->>'user_id','')::uuid,v_conversation,nullif(p_data->>'channel',''),coalesce(p_data->'metadata','{}'::jsonb));
 return jsonb_build_object('ok',true);
end $$;
grant execute on function inbox.ah_usage_record(jsonb) to service_role;
revoke all on function inbox.ah_usage_record(jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';
