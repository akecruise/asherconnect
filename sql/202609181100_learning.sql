-- Phase 11: private, review-only learning candidates.
create table if not exists answer_hub.learning_candidate (
 id uuid primary key default gen_random_uuid(), conversation_id uuid not null references inbox.conversation(id),
 question text not null, human_answer text not null, project_id uuid references core.project(id),
 occurrence_count int not null default 1 check(occurrence_count>0), quality_score numeric not null default 0.5 check(quality_score between 0 and 1),
 status text not null default 'pending' check(status in ('pending','approved','merged','rejected')), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(conversation_id,question,human_answer)
);
create index if not exists learning_candidate_pending_idx on answer_hub.learning_candidate(status,created_at desc);
alter table answer_hub.learning_candidate enable row level security;
revoke all on answer_hub.learning_candidate from public,anon,authenticated;
create or replace function inbox.ah_learning_create(p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid:=(p_data->>'conversation_id')::uuid; v_message uuid:=nullif(p_data->>'message_id','')::uuid; q text; a text; id uuid;
begin
 -- SECURITY DEFINER changes current_user to the function owner.  Authorize the
 -- request claim instead, so a browser/session caller can never impersonate
 -- the worker merely by reaching this RPC.
 if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role','') <> 'service_role' then
   perform answer_hub._fail('ah_not_allowed');
 end if;
 select m.content into q from inbox.message m where m.conversation_id=c and m.sender_type='contact' order by m.created_at desc limit 1;
 select m.content into a from inbox.message m where m.conversation_id=c and m.sender_type='agent'
   and (v_message is null or m.id=v_message) order by m.created_at desc limit 1;
 if coalesce(trim(q),'')='' or coalesce(trim(a),'')='' then return jsonb_build_object('created',false,'reason','missing_pair'); end if;
 insert into answer_hub.learning_candidate(conversation_id,question,human_answer,project_id) select c,q,a,i.project_id from inbox.conversation x join inbox.inbox i on i.id=x.inbox_id where x.id=c
 on conflict(conversation_id,question,human_answer) do update set occurrence_count=answer_hub.learning_candidate.occurrence_count+1,updated_at=now() returning answer_hub.learning_candidate.id into id;
 return jsonb_build_object('created',true,'id',id);
end $$;
grant execute on function inbox.ah_learning_create(jsonb) to service_role;
revoke all on function inbox.ah_learning_create(jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';
