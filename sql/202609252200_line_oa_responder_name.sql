-- Preserve the LINE OA owner's display name even when that owner has not been
-- linked to an ASHER sales_staff account. Also canonicalize LINE lifecycle
-- labels at the message boundary so a mojibake literal in an older receiver
-- cannot leak into the Inbox UI.

begin;

create or replace function inbox.line_oa_reply_event_attribution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid;
  v_name text;
begin
  if new.source <> 'line_oa_backfill' or new.external_event_id is null then
    return new;
  end if;

  select s.user_id, nullif(btrim(s.name), '')
    into v_user, v_name
    from inbox.sales_staff s
   where s.id = new.staff_id;

  v_name := coalesce(
    v_name,
    nullif(btrim(split_part(coalesce(new.note, ''), ' · LINE OA owner ', 1)), '')
  );

  update inbox.message m
     set responder_user_id = coalesce(m.responder_user_id, v_user),
         responder_display_name = coalesce(m.responder_display_name, v_name),
         sent_at = coalesce(m.sent_at, m.created_at)
   where m.conversation_id = new.conversation_id
     and m.external_message_id = new.external_event_id
     and m.sender_type = 'agent';
  return new;
end
$$;

drop trigger if exists line_oa_reply_event_attribution on inbox.human_reply_events;
create trigger line_oa_reply_event_attribution
after insert or update of staff_id, note, external_event_id on inbox.human_reply_events
for each row execute function inbox.line_oa_reply_event_attribution();

-- Existing backfill rows were inserted before the attribution trigger existed.
with attribution as (
  select h.conversation_id, h.external_event_id,
         s.user_id,
         coalesce(nullif(btrim(s.name), ''),
                  nullif(btrim(split_part(coalesce(h.note, ''), ' · LINE OA owner ', 1)), '')) as display_name
    from inbox.human_reply_events h
    left join inbox.sales_staff s on s.id = h.staff_id
   where h.source = 'line_oa_backfill'
     and h.external_event_id is not null
)
update inbox.message m
   set responder_user_id = coalesce(m.responder_user_id, a.user_id),
       responder_display_name = coalesce(m.responder_display_name, a.display_name),
       sent_at = coalesce(m.sent_at, m.created_at)
  from attribution a
 where m.conversation_id = a.conversation_id
   and m.external_message_id = a.external_event_id
   and m.sender_type = 'agent';

create or replace function inbox.canonical_system_message_label()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.sender_type = 'system' and new.event_type = 'follow' then
    new.content := '[ลูกค้าเพิ่มเพื่อน]';
  elsif new.sender_type = 'system' and new.event_type = 'unfollow' then
    new.content := '[ลูกค้าบล็อกบัญชี]';
  end if;
  return new;
end
$$;

drop trigger if exists canonical_system_message_label on inbox.message;
create trigger canonical_system_message_label
before insert or update of sender_type, event_type, content on inbox.message
for each row execute function inbox.canonical_system_message_label();

update inbox.message
   set content = case event_type
     when 'follow' then '[ลูกค้าเพิ่มเพื่อน]'
     when 'unfollow' then '[ลูกค้าบล็อกบัญชี]'
   end
 where sender_type = 'system'
   and event_type in ('follow', 'unfollow')
   and content is distinct from case event_type
     when 'follow' then '[ลูกค้าเพิ่มเพื่อน]'
     when 'unfollow' then '[ลูกค้าบล็อกบัญชี]'
   end;

revoke all on function inbox.line_oa_reply_event_attribution(),
  inbox.canonical_system_message_label() from public, anon, authenticated;

commit;
