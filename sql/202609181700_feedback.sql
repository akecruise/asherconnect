-- Phase 17 MVP: authenticated feedback report, isolated from send flow.
create table if not exists answer_hub.answer_feedback (
 id uuid primary key default gen_random_uuid(), answer_item_id uuid not null references answer_hub.answer_item(id), conversation_id uuid references inbox.conversation(id), reporter_id uuid, kind text not null check (kind in ('incorrect','outdated','other')), note text, created_at timestamptz not null default now()
);
create index if not exists answer_feedback_created_idx on answer_hub.answer_feedback(created_at desc);
alter table answer_hub.answer_feedback enable row level security;
revoke all on answer_hub.answer_feedback from public,anon,authenticated;
create or replace function inbox.ah_feedback(p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text:=coalesce(core.current_user_role(),''); v_answer uuid; v_user uuid; v_conv uuid; v_id uuid;
begin
 if v_role='' then perform answer_hub._fail('ah_not_allowed'); end if;
 if p_data->>'answer_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform answer_hub._fail('ah_invalid'); end if;
 if coalesce(p_data->>'kind','incorrect') not in ('incorrect','outdated','other') then perform answer_hub._fail('ah_invalid'); end if;
 v_answer:=(p_data->>'answer_id')::uuid; if not exists (select 1 from answer_hub.answer_item where id=v_answer and status='approved') then perform answer_hub._fail('ah_not_found'); end if; v_user:=nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid; if coalesce(p_data->>'conversation_id','')<>'' then v_conv:=(p_data->>'conversation_id')::uuid; end if;
 insert into answer_hub.answer_feedback(answer_item_id,conversation_id,reporter_id,kind,note) values(v_answer,v_conv,v_user,coalesce(p_data->>'kind','incorrect'),left(p_data->>'note',500)) returning id into v_id;
 return jsonb_build_object('id',v_id);
end $$;
grant execute on function inbox.ah_feedback(jsonb) to authenticated;
revoke all on function inbox.ah_feedback(jsonb) from public,anon;
notify pgrst,'reload schema';
