\set ON_ERROR_STOP on
begin;

-- Only these two LINE OA owners were explicitly verified against production users.
insert into inbox.sales_staff (name, user_id)
select v.name, u.id
from (values
  ('5831bb80-d90c-11e9-bf9e-fa163efc644f', 'nan@asher.local', 'NaN 📶🚺'),
  ('1327d450-e3f9-11e9-b5ee-fa163e3af8d6', 'ki@asher.local', '! 🍷Kikky Kanyarat 🍷')
) as v(owner_id, email, name)
join core."user" u on u.email = v.email
on conflict (user_id) where user_id is not null do nothing;

insert into inbox.sales_staff_identity (channel, external_id, staff_id)
select 'line_oa', v.owner_id, s.id
from (values
  ('5831bb80-d90c-11e9-bf9e-fa163efc644f', 'nan@asher.local'),
  ('1327d450-e3f9-11e9-b5ee-fa163e3af8d6', 'ki@asher.local')
) as v(owner_id, email)
join core."user" u on u.email = v.email
join inbox.sales_staff s on s.user_id = u.id
on conflict (channel, external_id) do nothing;

-- Backfilled replies carry the Manager owner ID in their event note. Use that
-- source evidence, never the shared account's visible name, for attribution.
update inbox.human_reply_events e
set staff_id = si.staff_id
from inbox.sales_staff_identity si
where e.source = 'line_oa_backfill'
  and si.channel = 'line_oa'
  and right(e.note, 36) = si.external_id
  and e.staff_id is distinct from si.staff_id;

update inbox.message m
set sender_id = s.user_id
from inbox.human_reply_events e
join inbox.sales_staff_identity si
  on si.channel = 'line_oa' and si.external_id = right(e.note, 36)
join inbox.sales_staff s on s.id = si.staff_id
where e.source = 'line_oa_backfill'
  and m.conversation_id = e.conversation_id
  and m.external_message_id = e.external_event_id
  and m.sender_type = 'agent'
  and m.sender_id is distinct from s.user_id;

-- "Asher Condo" is a shared OA identity. It cannot prove Nan sent a reply.
update inbox.message m
set sender_id = null
from inbox.human_reply_events e
where e.source = 'line_oa_backfill'
  and right(e.note, 36) = '133f05d0-e3f9-11e9-aaf6-fa163e4c3e33'
  and m.conversation_id = e.conversation_id
  and m.external_message_id = e.external_event_id
  and m.sender_type = 'agent'
  and m.sender_id is not null;

commit;
