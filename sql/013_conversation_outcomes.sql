-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9 ข้อ 0 — ชั้น label กลางของผลลัพธ์แต่ละรอบสนทนา
--
-- หนึ่งแถวต่อหนึ่ง episode (รอบถาม-ตอบ) — ใช้ร่วมกันระหว่าง CQX ใน Marketing OS,
-- รายงาน และงานเรียนรู้จากคำตอบของทีมในข้อ 1-2
--
-- ★ ไม่มีตรรกะ episode ในไฟล์นี้แม้แต่บรรทัดเดียว — อ่านจาก inbox.reply_episodes()
--   ที่ทำไว้ใน Phase 7 ทั้งหมด นิยาม "หนึ่งรอบ" มีที่เดียวในระบบ
--   ถ้าเขียนซ้ำที่นี่ วันหนึ่งรายงานกับ label จะนับไม่ตรงกันแล้วไม่มีใครรู้ว่าอันไหนถูก
--
-- ★ label_source='manual' ชนะ auto เสมอ — cron ทับของที่คนแก้ไม่ได้
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create table if not exists inbox.conversation_outcomes (
  conversation_id        uuid not null references inbox.conversation(id) on delete cascade,
  asked_at               timestamptz not null,
  inbox_id               uuid references inbox.inbox(id) on delete set null,
  channel                text,
  project                text,
  first_reply_at         timestamptz,
  first_reply_by         text not null check (first_reply_by in ('bot','human','none')),
  outcome                text not null check (outcome in
                           ('bot_only','human_took_over','customer_silent','lead','booked','unanswered')),
  customer_replied_after boolean not null default false,
  turns                  int not null default 0,
  topic                  text,
  responder_name         text,
  labeled_at             timestamptz not null default now(),
  label_source           text not null default 'auto' check (label_source in ('auto','manual')),
  primary key (conversation_id, asked_at)
);

create index if not exists conversation_outcomes_outcome_idx
  on inbox.conversation_outcomes(outcome, asked_at desc);
create index if not exists conversation_outcomes_asked_idx
  on inbox.conversation_outcomes(asked_at desc);

comment on table inbox.conversation_outcomes is
  'ผลลัพธ์ของแต่ละรอบสนทนา · หนึ่งแถวต่อ episode · manual ชนะ auto';
comment on column inbox.conversation_outcomes.outcome is
  'unanswered = เราไม่ได้ตอบ · customer_silent = เราตอบแล้วลูกค้าเงียบเกิน 24 ชม.';
comment on column inbox.conversation_outcomes.turns is
  'จำนวนข้อความทั้งหมดในช่วงของ episode นั้น (นับทั้งของลูกค้าและของเรา)';

alter table inbox.conversation_outcomes enable row level security;
revoke all on inbox.conversation_outcomes from public, anon, authenticated;
grant select, insert, update, delete on inbox.conversation_outcomes to service_role;
-- CQX / Marketing OS อ่านได้ แต่แก้ได้ทาง RPC เท่านั้น
grant select on inbox.conversation_outcomes to authenticated;


/**
 * ติด label ให้ทุก episode ในช่วงที่กำหนด
 *
 * ลำดับการตัดสิน outcome (บนสุดชนะ)
 *   booked           มีนัดเข้าชมเกิดขึ้นในรอบนี้           ← ผลลัพธ์ปลายทางที่อยากได้
 *   lead             ลูกค้าให้เบอร์หรือ LINE ในรอบนี้
 *   unanswered       เราไม่ได้ตอบเลย                      ← ความผิดของเรา ไม่ใช่ลูกค้าเงียบ
 *   customer_silent  เราตอบแล้ว ลูกค้าไม่ตอบต่อภายใน 24 ชม.
 *   human_took_over  คนเป็นคนตอบก่อน
 *   bot_only         บอทตอบ แล้วลูกค้าคุยต่อ
 *
 * ★ customer_silent ตัดสินได้ก็ต่อเมื่อผ่าน 24 ชม. ไปแล้วจริง
 *   ถ้ายังไม่ครบ ให้เป็น bot_only / human_took_over ไปก่อน แล้วรอบหน้าค่อยอัปเกรด
 *   ไม่งั้นรอบที่เพิ่งตอบไปห้านาทีจะถูกตราหน้าว่าลูกค้าเงียบทันที
 */
create or replace function inbox.label_conversation_outcomes(
  p_from timestamptz, p_to timestamptz, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_rows int;
begin
  with eps as (
    select e.*,
           -- ช่วงของ episode = ตั้งแต่ถูกถาม จนถึงรอบถัดไปของบทสนทนาเดียวกัน
           lead(e.asked_at) over (partition by e.conversation_id order by e.asked_at) as next_asked_at
      from inbox.reply_episodes(p_from, p_to) e
  ),
  scoped as (
    select e.*,
           coalesce(e.next_asked_at, p_now) as ends_at,
           -- channel มากับ reply_episodes อยู่แล้ว ไม่ต้องหยิบซ้ำ (ชื่อจะชนกันทันที)
           c.inbox_id, p.code as project
      from eps e
      join inbox.conversation c on c.id = e.conversation_id
      join inbox.inbox i on i.id = c.inbox_id
      left join core.project p on p.id = i.project_id
  ),
  facts as (
    select s.*,
           (select count(*) from inbox.message m
             where m.conversation_id = s.conversation_id
               and m.created_at >= s.asked_at and m.created_at < s.ends_at
               and m.sender_type in ('contact','agent','bot'))::int as turns,
           -- ลูกค้าคุยต่อไหมหลังคำตอบแรก (ในกรอบ 24 ชม. ตามกฎ)
           exists (select 1 from inbox.message m
                    where m.conversation_id = s.conversation_id and m.sender_type = 'contact'
                      and s.answered_at is not null
                      and m.created_at >  s.answered_at
                      and m.created_at <= s.answered_at + interval '24 hours') as replied_after,
           -- ให้เบอร์หรือ LINE ในรอบนี้ = เกณฑ์เดียวกับที่ decide_notify ใช้
           exists (select 1 from inbox.message m
                    where m.conversation_id = s.conversation_id and m.sender_type = 'contact'
                      and m.created_at >= s.asked_at and m.created_at < s.ends_at
                      and (inbox.extract_phone(m.content) is not null
                           or inbox.extract_line_id(m.content) is not null)) as got_lead,
           -- นัดเข้าชมที่บันทึกจาก Sales Workspace
           exists (select 1 from crm.activity a
                    where a.conversation_id = s.conversation_id and a.type = 'site_visit'
                      and a.created_at >= s.asked_at and a.created_at < s.ends_at) as booked,
           (select mi.primary_topic from inbox.message_intents mi
             where mi.conversation_id = s.conversation_id
               and mi.created_at >= s.asked_at and mi.created_at < s.ends_at
             order by mi.created_at limit 1) as intent_topic,
           (select d.topic from inbox.bot_decisions d
             where d.conversation_id = s.conversation_id
               and d.decided_at >= s.asked_at and d.decided_at < s.ends_at
               and d.topic is not null
             order by d.decided_at limit 1) as decision_topic
      from scoped s
  ),
  labeled as (
    select f.conversation_id, f.asked_at, f.inbox_id, f.channel, f.project,
           f.answered_at as first_reply_at,
           case when f.responder is null then 'none'
                when f.responder = 'bot' then 'bot' else 'human' end as first_reply_by,
           case
             when f.booked then 'booked'
             when f.got_lead then 'lead'
             when f.answered_at is null then 'unanswered'
             when not f.replied_after and p_now >= f.answered_at + interval '24 hours'
               then 'customer_silent'
             when f.responder <> 'bot' then 'human_took_over'
             else 'bot_only'
           end as outcome,
           f.replied_after as customer_replied_after,
           f.turns,
           coalesce(f.intent_topic, f.decision_topic) as topic,
           case when f.responder = 'bot' then null else f.responder end as responder_name
      from facts f
  )
  insert into inbox.conversation_outcomes as o
    (conversation_id, asked_at, inbox_id, channel, project, first_reply_at, first_reply_by,
     outcome, customer_replied_after, turns, topic, responder_name, labeled_at, label_source)
  select l.conversation_id, l.asked_at, l.inbox_id, l.channel, l.project, l.first_reply_at,
         l.first_reply_by, l.outcome, l.customer_replied_after, l.turns, l.topic,
         l.responder_name, p_now, 'auto'
    from labeled l
  on conflict (conversation_id, asked_at) do update
     set inbox_id = excluded.inbox_id, channel = excluded.channel, project = excluded.project,
         first_reply_at = excluded.first_reply_at, first_reply_by = excluded.first_reply_by,
         outcome = excluded.outcome, customer_replied_after = excluded.customer_replied_after,
         turns = excluded.turns, topic = excluded.topic, responder_name = excluded.responder_name,
         labeled_at = excluded.labeled_at
   -- ★ ของที่คนแก้เอง ห้ามถูกทับ
   where o.label_source <> 'manual';

  get diagnostics v_rows = row_count;
  return jsonb_build_object('labeled', v_rows, 'from', p_from, 'to', p_to);
end $$;

revoke all on function inbox.label_conversation_outcomes(timestamptz,timestamptz,timestamptz)
  from public, anon, authenticated;
grant execute on function inbox.label_conversation_outcomes(timestamptz,timestamptz,timestamptz)
  to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- cron ทุก 15 นาที
--
-- ย้อนหลัง 3 วันทุกครั้ง ไม่ใช่แค่ 15 นาทีที่ผ่านมา เพราะ outcome เปลี่ยนได้ตามเวลา
-- รอบที่เพิ่งตอบเมื่อวานยังไม่ครบ 24 ชม. จะถูกอัปเกรดเป็น customer_silent ในรอบถัด ๆ ไป
-- ───────────────────────────────────────────────────────────────────────────
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'asher-label-outcomes';
select cron.schedule('asher-label-outcomes', '*/15 * * * *',
  $cron$select inbox.label_conversation_outcomes(now() - interval '3 days', now())$cron$);

commit;
