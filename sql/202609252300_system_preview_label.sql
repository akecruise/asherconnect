-- Historical follow/unfollow rows were repaired after their conversation
-- preview snapshot had already been written. Reconcile only conversations
-- whose latest message is one of those canonical lifecycle events.

begin;

with latest as (
  select distinct on (m.conversation_id)
         m.conversation_id, m.content, m.event_type
    from inbox.message m
   order by m.conversation_id, m.created_at desc, m.id desc
)
update inbox.conversation c
   set last_message_preview = l.content
  from latest l
 where c.id = l.conversation_id
   and l.event_type in ('follow', 'unfollow')
   and c.last_message_preview is distinct from l.content;

commit;
