-- =====================================================================
-- 202610021200_line_broadcast.sql — ตัวส่ง LINE หลายคน + สถานะ follow
-- =====================================================================
-- spec: docs/handoff/2026-10-02-line-broadcast-sender.md · docs/BOUNDARIES.md
--
-- ★ ไม่แตะ connect_private.api และไม่แตะ connect_private.receive_event เด็ดขาด
--   ทั้งสองตัวบน VPS ใหม่กว่า repo — ไฟล์นี้ใช้ฟังก์ชันแยกใน schema inbox
--   เรียกผ่าน rpcDirect(service, ...) แบบเดียวกับ queue_counts / media_library_*
--   สถานะ follow เก็บด้วย "ทริกเกอร์ after insert บน inbox.message" ตามแบบ
--   trg_crm_publish_message (sql/202609211300) ไม่ใช่ด้วยการเขียน receive_event ใหม่
--
-- ★ Connect เป็นตัวส่งอย่างเดียว — หน้าจอ campaign อยู่ที่ CRM (BOUNDARIES.md)
--   ที่นี่จึงไม่มีตารางกลุ่มเป้าหมาย ไม่มีเนื้อหา template ไม่มีตารางเวลา
--
-- ★ สิทธิ์: ทุกฟังก์ชันในไฟล์นี้ grant ให้ service_role เท่านั้น
--   ทางเข้าเดียวคือ /internal/* ที่ยืนยันตัวด้วย CONNECT_SERVICE_TOKEN (ไม่ใช่ login ผู้ใช้)
--   authenticated ต้องเรียกไม่ได้ ไม่งั้นเซลส์คนเดียวยิง broadcast ได้จากหน้าเว็บ
--
-- ★ วิธีรันด้วยมือ (deploy script ไม่รัน migration):
--   local : node sql/run.mjs apply --db "$DB"
--   VPS   : backup ก่อน แล้ว
--           docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--             < sql/202610021200_line_broadcast.sql
-- ★ รันซ้ำได้ (if not exists / create or replace / alter แบบ drop ก่อน)

begin;

-- ── 0. เปิดทางให้ outbox เดิมพา event ชนิดใหม่ไป CRM ───────────────────
--
-- inbox.crm_publish_outbox (202609211300) ล็อก event_type ไว้สองค่า
-- ขยายแบบ additive — ของเดิมทุกแถวยังผ่าน check เท่าเดิม
--
-- ★★ ตัวดูด outbox (crmPublisherWorker) ไม่อยู่ใน server.mjs แล้ว — หายไปตอน
--    snapshot 20a7799 เอาโค้ดจาก VPS กลับเข้า repo ไฟล์นี้จึง "เขียนเข้าคิว"
--    อย่างเดียวตามที่ผู้ใช้ตัดสินเมื่อ 2026-10-02 แถวจะค้างเป็น pending จนกว่าจะ
--    มีคนกู้ worker กลับมา (ดู docs/handoff/2026-10-02-line-broadcast-sender.md)
alter table inbox.crm_publish_outbox drop constraint if exists crm_publish_outbox_event_type_check;
alter table inbox.crm_publish_outbox add constraint crm_publish_outbox_event_type_check
  check (event_type in ('message.received', 'message.sent',
                        'channel_identity.follow_changed',
                        'broadcast.batch_result', 'broadcast.completed'));

-- ★★ event_id ของ inbox.crm_publish_outbox เป็น unique ทั้งตาราง ไม่ใช่ unique ต่อชนิด
--   และ trg_crm_publish_message (ของเดิม) จองค่า = id ของ message ไปแล้วทุกแถว
--   ถ้าเราใช้ id ของ message ตรง ๆ เป็น event_id ของ event ชนิดใหม่ จะกลายเป็นว่า
--   ตัวที่ทริกเกอร์ทำงานทีหลังถูก on conflict do nothing กลืนหายไปเงียบ ๆ
--   (เรียงตามตัวอักษร: trg_broadcast_follow_track < trg_crm_publish_message < trg_postback_publish
--    → follow_changed เคยไปกลืน message.sent ทิ้ง และ postback ไม่เคยถูกเขียนลงคิวเลย)
--   ทางแก้: ผสมชนิดของ event เข้าไปในคีย์ ยังคงเดาได้แน่นอน (md5 ของค่าเดิมได้ค่าเดิม)
--   จึงยิงซ้ำไม่เกิดแถวที่สอง แต่ event ต่างชนิดของ message เดียวกันอยู่ร่วมกันได้
create or replace function inbox.crm_event_id(p_source uuid, p_event_type text)
returns uuid language sql immutable set search_path = '' as $$
  select md5(p_source::text || ':' || p_event_type)::uuid
$$;

-- ตัวเขียนคิวตัวเดียวของไฟล์นี้ — event_id ต้อง deterministic เสมอ
-- (retry_key ของ batch / id ของ job / id ของ message ผ่าน inbox.crm_event_id)
create or replace function inbox.broadcast_emit(
  p_event_id uuid, p_event_type text, p_aggregate_type text,
  p_aggregate_id text, p_occurred_at timestamptz, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into inbox.crm_publish_outbox
    (event_id, event_type, aggregate_type, aggregate_id, occurred_at, payload)
  values (p_event_id, p_event_type, p_aggregate_type, p_aggregate_id, p_occurred_at, p_payload)
  on conflict (event_id) do nothing;
exception when others then
  -- คิวไป CRM เป็นเรื่องของการเชื่อมระบบ ห้ามทำให้การส่งจริงล้มตาม
  null;
end $$;

-- ── 1. สถานะ follow / unfollow ต่อ (ช่องทาง, userId) ──────────────────
--
-- ของเดิมมีอยู่แล้วแต่ไม่พอ: connect_private.receive_event ติดธงที่
-- core.contact.blocked ซึ่งเป็นระดับ "คน" รวมทุกช่องทาง (unified identity)
-- คนที่บล็อก LINE แต่ยังคุย Messenger อยู่จะถูกตัดออกจาก broadcast ผิดตัว
-- ตารางนี้จึงเก็บแยกต่อช่องทางตามที่สเปกขอ — ไม่แตะคอลัมน์ blocked เดิม
create table if not exists connect_private.channel_follow (
  inbox_id         uuid not null references inbox.inbox(id) on delete cascade,
  external_user_id text not null,
  channel          text not null,
  following        boolean not null,
  changed_at       timestamptz not null default now(),
  source           text not null default 'webhook',
  primary key (inbox_id, external_user_id)
);
create index if not exists channel_follow_following_idx
  on connect_private.channel_follow (inbox_id) where following;

alter table connect_private.channel_follow enable row level security;
revoke all on connect_private.channel_follow from public, anon, authenticated;

comment on table connect_private.channel_follow is
  'สถานะ follow/unfollow ล่าสุดต่อ (ช่องทาง, userId) — ของจริงอยู่ที่ Connect เท่านั้น '
  'ใช้ตัดคนที่บล็อกออกจาก broadcast · แยกจาก core.contact.blocked ที่เป็นระดับคน';

-- ทริกเกอร์: message ที่ event_type เป็น follow/unfollow → อัปเดตสถานะ + ส่ง event
-- ★ ทำแบบเดียวกับ trg_crm_publish_message — กลืน exception ของตัวเองทั้งหมด
--   ข้อความขาเข้าของลูกค้าห้าม rollback เพราะงานผนวกชิ้นนี้พัง
create or replace function inbox.broadcast_follow_track()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, inbox, core, connect_private as $$
declare v_inbox inbox.inbox; v_external text; v_following boolean; v_changed boolean;
begin
  if NEW.event_type not in ('follow', 'unfollow') then return NEW; end if;
  v_following := NEW.event_type = 'follow';

  select i.* into v_inbox
    from inbox.conversation c join inbox.inbox i on i.id = c.inbox_id
   where c.id = NEW.conversation_id;
  if v_inbox.id is null then return NEW; end if;

  select ci.external_id into v_external
    from inbox.conversation c
    join core.contact_identity ci
      on ci.contact_id = c.contact_id
     and ci.channel = v_inbox.channel
     and ci.account_key = v_inbox.id::text
   where c.id = NEW.conversation_id
   limit 1;
  if v_external is null then return NEW; end if;

  insert into connect_private.channel_follow
    (inbox_id, external_user_id, channel, following, changed_at)
  values (v_inbox.id, v_external, v_inbox.channel, v_following, NEW.created_at)
  on conflict (inbox_id, external_user_id) do update
     set following = excluded.following, changed_at = excluded.changed_at,
         channel = excluded.channel, source = 'webhook'
   -- event ที่มาช้ากว่าสถานะที่มีอยู่ ห้ามย้อนเวลา
   where connect_private.channel_follow.changed_at <= excluded.changed_at
  returning true into v_changed;

  if coalesce(v_changed, false) then
    perform inbox.broadcast_emit(
      inbox.crm_event_id(NEW.id, 'channel_identity.follow_changed'),
      'channel_identity.follow_changed', 'channel_identity',
      v_inbox.id::text || ':' || v_external, NEW.created_at,
      jsonb_build_object(
        'provider', v_inbox.channel, 'account_scope', v_inbox.id::text,
        'external_id', v_external, 'following', v_following,
        'conversation_id', NEW.conversation_id::text));
  end if;
  return NEW;
exception when others then
  return NEW;
end $$;

drop trigger if exists trg_broadcast_follow_track on inbox.message;
create trigger trg_broadcast_follow_track
  after insert on inbox.message
  for each row execute function inbox.broadcast_follow_track();

-- เติมสถานะย้อนหลังจาก message ที่มีอยู่แล้ว (แถวล่าสุดต่อคนชนะ)
-- รันซ้ำได้ — ของที่ webhook เขียนทีหลังจะไม่ถูกทับเพราะเทียบ changed_at
insert into connect_private.channel_follow
  (inbox_id, external_user_id, channel, following, changed_at, source)
select distinct on (i.id, ci.external_id)
       i.id, ci.external_id, i.channel, m.event_type = 'follow', m.created_at, 'backfill'
  from inbox.message m
  join inbox.conversation c on c.id = m.conversation_id
  join inbox.inbox i on i.id = c.inbox_id
  join core.contact_identity ci
    on ci.contact_id = c.contact_id and ci.channel = i.channel and ci.account_key = i.id::text
 where m.event_type in ('follow', 'unfollow')
 order by i.id, ci.external_id, m.created_at desc
on conflict (inbox_id, external_user_id) do nothing;

-- ── 2. ตารางงานส่ง ────────────────────────────────────────────────────
create table if not exists connect_private.broadcast_job (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  inbox_id        uuid not null references inbox.inbox(id) on delete restrict,
  channel_key     text not null,
  messages        jsonb not null,
  requested_by    text,
  crm_campaign_id text,
  is_test         boolean not null default false,
  status          text not null default 'queued'
                  check (status in ('queued','sending','sent','partially_failed','failed','cancelled')),
  fail_reason     text,
  recipient_count int not null default 0,
  sent_count      int not null default 0,
  failed_count    int not null default 0,
  skipped_count   int not null default 0,
  lease_until     timestamptz,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
create index if not exists broadcast_job_open_idx
  on connect_private.broadcast_job (status, created_at) where status in ('queued','sending');

create table if not exists connect_private.broadcast_batch (
  job_id          uuid not null references connect_private.broadcast_job(id) on delete cascade,
  batch_no        int not null,
  -- ★ สร้างครั้งเดียวตอนรับงาน ห้ามเปลี่ยนตลอดชีวิตของ batch
  --   LINE ใช้คีย์นี้กันข้อความซ้ำ เปลี่ยนเมื่อไหร่ = ลูกค้าได้ข้อความสองรอบ
  retry_key       uuid not null default gen_random_uuid(),
  status          text not null default 'queued'
                  check (status in ('queued','sending','sent','failed','cancelled')),
  http_status     int,
  line_request_id text,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  error           text,
  primary key (job_id, batch_no)
);
create index if not exists broadcast_batch_claim_idx
  on connect_private.broadcast_batch (status, next_attempt_at, lease_until);

create table if not exists connect_private.broadcast_recipient (
  job_id           uuid not null references connect_private.broadcast_job(id) on delete cascade,
  external_user_id text not null,
  contact_ref      text,
  batch_no         int,
  status           text not null default 'queued'
                   check (status in ('queued','sent','failed','skipped')),
  reason           text,
  primary key (job_id, external_user_id)
);
create index if not exists broadcast_recipient_batch_idx
  on connect_private.broadcast_recipient (job_id, batch_no);

alter table connect_private.broadcast_job enable row level security;
alter table connect_private.broadcast_batch enable row level security;
alter table connect_private.broadcast_recipient enable row level security;
revoke all on connect_private.broadcast_job, connect_private.broadcast_batch,
              connect_private.broadcast_recipient from public, anon, authenticated;

-- ── 3. รับงาน (idempotent) ────────────────────────────────────────────
-- p = {idempotency_key, inbox_id, channel_key, messages, requested_by,
--      crm_campaign_id, is_test, batch_size, recipients:[{external_user_id, contact_ref}]}
-- คืน {job_id, reused, accepted, skipped:[{id, reason}]}
--
-- ★ การตรวจเนื้อหาข้อความ (text/image, https) ทำที่ชั้น Node ก่อนเรียกมา
--   ที่นี่ตรวจเฉพาะสิ่งที่ต้องใช้ฐานถึงจะรู้ได้: ใครบล็อกไปแล้ว
create or replace function inbox.broadcast_enqueue(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(coalesce(p->>'idempotency_key','')), '');
  v_inbox uuid := nullif(p->>'inbox_id','')::uuid;
  v_batch_size int := greatest(1, least(coalesce((p->>'batch_size')::int, 500), 500));
  v_job connect_private.broadcast_job;
  v_skipped jsonb := '[]'::jsonb;
  v_accepted int := 0;
  v_batches int;
begin
  if v_key is null or v_inbox is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  -- idempotency_key ซ้ำ → คืนงานเดิม ไม่สร้างใหม่ ไม่แตะผู้รับเดิม
  select * into v_job from connect_private.broadcast_job where idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'job_id', v_job.id, 'reused', true, 'accepted', v_job.recipient_count,
      'skipped', coalesce((select jsonb_agg(jsonb_build_object('id', r.external_user_id, 'reason', r.reason))
                             from connect_private.broadcast_recipient r
                            where r.job_id = v_job.id and r.status = 'skipped'), '[]'::jsonb));
  end if;

  insert into connect_private.broadcast_job
    (idempotency_key, inbox_id, channel_key, messages, requested_by, crm_campaign_id, is_test)
  values (v_key, v_inbox, coalesce(p->>'channel_key',''), coalesce(p->'messages','[]'::jsonb),
          nullif(p->>'requested_by',''), nullif(p->>'crm_campaign_id',''),
          coalesce((p->>'is_test')::boolean, false))
  returning * into v_job;

  -- ผู้รับ: ตัดซ้ำในคำขอเดียวกันก่อน แล้วค่อยติดสถานะ skipped ให้คนที่บล็อกไปแล้ว
  -- ★ ไม่มีแถวใน channel_follow = ยังไม่เคยเห็น event follow/unfollow ของคนนั้น
  --   ถือว่า "ส่งได้" ตามเดิม — ฐานนี้เพิ่งเริ่มเก็บ จะตัดคนทิ้งเพราะไม่มีข้อมูลไม่ได้
  insert into connect_private.broadcast_recipient
    (job_id, external_user_id, contact_ref, status, reason)
  select distinct on (x.external_user_id)
         v_job.id, x.external_user_id, x.contact_ref,
         case when coalesce(f.following, true) then 'queued' else 'skipped' end,
         case when coalesce(f.following, true) then null else 'unfollowed' end
    from jsonb_to_recordset(coalesce(p->'recipients','[]'::jsonb))
           as x(external_user_id text, contact_ref text)
    left join connect_private.channel_follow f
      on f.inbox_id = v_inbox and f.external_user_id = x.external_user_id
   where nullif(btrim(x.external_user_id), '') is not null
   order by x.external_user_id
  on conflict (job_id, external_user_id) do nothing;

  -- แบ่ง batch ให้เฉพาะคนที่ยังอยู่ในคิว เรียงตาม userId เพื่อให้ผลซ้ำได้
  with numbered as (
    select external_user_id,
           ((row_number() over (order by external_user_id) - 1) / v_batch_size)::int + 1 as batch_no
      from connect_private.broadcast_recipient
     where job_id = v_job.id and status = 'queued')
  update connect_private.broadcast_recipient r
     set batch_no = n.batch_no
    from numbered n
   where r.job_id = v_job.id and r.external_user_id = n.external_user_id;

  insert into connect_private.broadcast_batch (job_id, batch_no)
  select distinct v_job.id, batch_no
    from connect_private.broadcast_recipient
   where job_id = v_job.id and batch_no is not null
  on conflict do nothing;

  select count(*) into v_accepted
    from connect_private.broadcast_recipient where job_id = v_job.id and status = 'queued';
  select coalesce(jsonb_agg(jsonb_build_object('id', external_user_id, 'reason', reason)), '[]'::jsonb)
    into v_skipped
    from connect_private.broadcast_recipient where job_id = v_job.id and status = 'skipped';
  select count(*) into v_batches from connect_private.broadcast_batch where job_id = v_job.id;

  update connect_private.broadcast_job
     set recipient_count = v_accepted,
         skipped_count = jsonb_array_length(v_skipped),
         -- ไม่มีใครให้ส่งเลย = จบทันที ไม่ต้องให้ worker มาเจองานเปล่า
         status = case when v_batches = 0 then 'sent' else 'queued' end,
         finished_at = case when v_batches = 0 then now() else null end
   where id = v_job.id;

  return jsonb_build_object('job_id', v_job.id, 'reused', false,
                            'accepted', v_accepted, 'skipped', v_skipped);
end $$;

-- ── 4. งานถัดไปที่ยังไม่เริ่ม (ให้ Node ไปเช็คโควตาก่อนปล่อยส่ง) ────────
create or replace function inbox.broadcast_next_job(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job connect_private.broadcast_job;
        v_lease int := greatest(10, least(coalesce((p->>'lease_seconds')::int, 120), 900));
begin
  update connect_private.broadcast_job j
     set lease_until = now() + make_interval(secs => v_lease)
   where j.id = (select id from connect_private.broadcast_job
                  where status = 'queued' and (lease_until is null or lease_until < now())
                  order by created_at
                  for update skip locked limit 1)
  returning * into v_job;
  if not found then return null; end if;
  return jsonb_build_object('job_id', v_job.id, 'inbox_id', v_job.inbox_id,
                            'channel_key', v_job.channel_key, 'is_test', v_job.is_test,
                            'recipient_count', v_job.recipient_count);
end $$;

create or replace function inbox.broadcast_job_start(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update connect_private.broadcast_job
     set status = 'sending', started_at = coalesce(started_at, now()), lease_until = null
   where id = (p->>'job_id')::uuid and status = 'queued';
  return jsonb_build_object('ok', found);
end $$;

-- ล้มทั้งงานโดยไม่ส่งสักคน (โควตาไม่พอ / ช่องทางหาย) — ห้ามส่งบางส่วน
create or replace function inbox.broadcast_job_fail(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job uuid := (p->>'job_id')::uuid; v_reason text := coalesce(p->>'reason','failed');
begin
  update connect_private.broadcast_job
     set status = 'failed', fail_reason = v_reason, finished_at = now(), lease_until = null
   where id = v_job and status in ('queued','sending');
  if not found then return jsonb_build_object('ok', false); end if;
  update connect_private.broadcast_batch set status = 'cancelled' where job_id = v_job and status = 'queued';
  update connect_private.broadcast_recipient set status = 'failed', reason = v_reason
   where job_id = v_job and status = 'queued';
  perform inbox.broadcast_complete(jsonb_build_object('job_id', v_job));
  return jsonb_build_object('ok', true);
end $$;

-- ── 5. claim batch ────────────────────────────────────────────────────
-- คืน {job_id, batch_no, retry_key, attempts, messages, recipients[]}
create or replace function inbox.broadcast_claim_batch(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch connect_private.broadcast_batch; v_job connect_private.broadcast_job;
        v_lease int := greatest(10, least(coalesce((p->>'lease_seconds')::int, 120), 900));
begin
  update connect_private.broadcast_batch b
     set status = 'sending', attempts = b.attempts + 1,
         lease_until = now() + make_interval(secs => v_lease)
   where (b.job_id, b.batch_no) = (
     select bb.job_id, bb.batch_no
       from connect_private.broadcast_batch bb
       join connect_private.broadcast_job jj on jj.id = bb.job_id
      where jj.status = 'sending'
        and bb.status in ('queued','sending')
        and bb.next_attempt_at <= now()
        and (bb.lease_until is null or bb.lease_until < now())
      order by bb.next_attempt_at, bb.job_id, bb.batch_no
      for update of bb skip locked limit 1)
  returning * into v_batch;
  if not found then return null; end if;

  select * into v_job from connect_private.broadcast_job where id = v_batch.job_id;
  return jsonb_build_object(
    'job_id', v_batch.job_id, 'batch_no', v_batch.batch_no, 'retry_key', v_batch.retry_key,
    'attempts', v_batch.attempts, 'inbox_id', v_job.inbox_id, 'channel_key', v_job.channel_key,
    'is_test', v_job.is_test, 'messages', v_job.messages,
    'recipients', coalesce((select jsonb_agg(r.external_user_id order by r.external_user_id)
                              from connect_private.broadcast_recipient r
                             where r.job_id = v_batch.job_id and r.batch_no = v_batch.batch_no
                               and r.status in ('queued','failed')), '[]'::jsonb));
end $$;

-- ── 6. ผลของ batch ────────────────────────────────────────────────────
-- p = {job_id, batch_no, outcome: sent|failed|retry, http_status, line_request_id,
--      error, backoff_seconds}
create or replace function inbox.broadcast_batch_finish(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job uuid := (p->>'job_id')::uuid; v_no int := (p->>'batch_no')::int;
        v_outcome text := coalesce(p->>'outcome','failed');
        v_batch connect_private.broadcast_batch; v_ids jsonb;
begin
  if v_outcome = 'retry' then
    update connect_private.broadcast_batch
       set status = 'queued', lease_until = null,
           next_attempt_at = now() + make_interval(secs => greatest(1, coalesce((p->>'backoff_seconds')::int, 30))),
           http_status = nullif(p->>'http_status','')::int, error = nullif(p->>'error','')
     where job_id = v_job and batch_no = v_no
    returning * into v_batch;
    return jsonb_build_object('status', 'queued', 'attempts', v_batch.attempts);
  end if;

  update connect_private.broadcast_batch
     set status = case when v_outcome = 'sent' then 'sent' else 'failed' end,
         lease_until = null, http_status = nullif(p->>'http_status','')::int,
         line_request_id = nullif(p->>'line_request_id',''), error = nullif(p->>'error','')
   where job_id = v_job and batch_no = v_no
  returning * into v_batch;
  if not found then return jsonb_build_object('status', 'unknown'); end if;

  update connect_private.broadcast_recipient
     set status = case when v_outcome = 'sent' then 'sent' else 'failed' end,
         reason = case when v_outcome = 'sent' then null else nullif(p->>'error','') end
   where job_id = v_job and batch_no = v_no and status in ('queued','failed');

  update connect_private.broadcast_job j
     set sent_count   = (select count(*) from connect_private.broadcast_recipient r
                          where r.job_id = v_job and r.status = 'sent'),
         failed_count = (select count(*) from connect_private.broadcast_recipient r
                          where r.job_id = v_job and r.status = 'failed')
   where j.id = v_job;

  -- ★ ไม่ส่งรายชื่อ userId เต็มออกไปใน log — แต่ event ไป CRM ต้องมี เพราะ CRM
  --   ต้องรู้ว่าใครไม่ถึงเพื่ออัปเดตกลุ่ม · ท่อนี้เป็นวงในระหว่างสองระบบ
  select coalesce(jsonb_agg(jsonb_build_object('id', r.external_user_id, 'ref', r.contact_ref,
                                               'status', r.status) order by r.external_user_id), '[]'::jsonb)
    into v_ids
    from connect_private.broadcast_recipient r where r.job_id = v_job and r.batch_no = v_no;

  perform inbox.broadcast_emit(
    v_batch.retry_key, 'broadcast.batch_result', 'broadcast', v_job::text, now(),
    jsonb_build_object('job_id', v_job, 'batch_no', v_no, 'outcome', v_outcome,
                       'http_status', nullif(p->>'http_status','')::int,
                       'line_request_id', nullif(p->>'line_request_id',''),
                       'recipients', v_ids));

  return inbox.broadcast_complete(jsonb_build_object('job_id', v_job));
end $$;

-- จบงานเมื่อไม่มี batch ที่ยังค้าง — เรียกซ้ำได้ ไม่ส่ง event ซ้ำ (event_id = job id)
create or replace function inbox.broadcast_complete(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job connect_private.broadcast_job; v_open int; v_failed int; v_status text;
begin
  select * into v_job from connect_private.broadcast_job where id = (p->>'job_id')::uuid;
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  if v_job.status not in ('queued','sending','failed') then
    return jsonb_build_object('status', v_job.status);
  end if;

  select count(*) filter (where status in ('queued','sending')),
         count(*) filter (where status = 'failed')
    into v_open, v_failed
    from connect_private.broadcast_batch where job_id = v_job.id;
  if v_open > 0 then return jsonb_build_object('status', v_job.status); end if;

  v_status := case
    when v_job.status = 'failed' then 'failed'
    when v_failed = 0 then 'sent'
    when v_job.sent_count = 0 then 'failed'
    else 'partially_failed' end;

  update connect_private.broadcast_job
     set status = v_status, finished_at = coalesce(finished_at, now()), lease_until = null
   where id = v_job.id
  returning * into v_job;

  perform inbox.broadcast_emit(
    v_job.id, 'broadcast.completed', 'broadcast', v_job.id::text, coalesce(v_job.finished_at, now()),
    jsonb_build_object('job_id', v_job.id, 'crm_campaign_id', v_job.crm_campaign_id,
                       'status', v_status, 'recipient_count', v_job.recipient_count,
                       'sent_count', v_job.sent_count, 'failed_count', v_job.failed_count,
                       'skipped_count', v_job.skipped_count, 'fail_reason', v_job.fail_reason));
  return jsonb_build_object('status', v_status);
end $$;

-- ── 7. อ่านสถานะ / ยกเลิก ─────────────────────────────────────────────
create or replace function inbox.broadcast_status(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job connect_private.broadcast_job;
begin
  select * into v_job from connect_private.broadcast_job where id = (p->>'job_id')::uuid;
  if not found then raise exception 'job_not_found' using errcode = '42704'; end if;
  return jsonb_build_object(
    'job_id', v_job.id, 'status', v_job.status, 'fail_reason', v_job.fail_reason,
    'channel_key', v_job.channel_key, 'crm_campaign_id', v_job.crm_campaign_id,
    'is_test', v_job.is_test, 'recipient_count', v_job.recipient_count,
    'sent_count', v_job.sent_count, 'failed_count', v_job.failed_count,
    'skipped_count', v_job.skipped_count, 'created_at', v_job.created_at,
    'started_at', v_job.started_at, 'finished_at', v_job.finished_at,
    'batches', coalesce((select jsonb_agg(jsonb_build_object(
                                  'batch_no', b.batch_no, 'status', b.status,
                                  'attempts', b.attempts, 'http_status', b.http_status,
                                  'line_request_id', b.line_request_id, 'error', b.error)
                                order by b.batch_no)
                           from connect_private.broadcast_batch b where b.job_id = v_job.id), '[]'::jsonb));
end $$;

-- ยกเลิกเฉพาะ batch ที่ยังไม่ส่ง — ของที่ LINE รับไปแล้วเรียกคืนไม่ได้
create or replace function inbox.broadcast_cancel(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job uuid := (p->>'job_id')::uuid; v_cancelled int;
begin
  perform 1 from connect_private.broadcast_job where id = v_job;
  if not found then raise exception 'job_not_found' using errcode = '42704'; end if;

  update connect_private.broadcast_batch
     set status = 'cancelled', lease_until = null
   where job_id = v_job and status = 'queued';
  get diagnostics v_cancelled = row_count;

  update connect_private.broadcast_recipient r
     set status = 'skipped', reason = 'cancelled'
   where r.job_id = v_job and r.status = 'queued'
     and exists (select 1 from connect_private.broadcast_batch b
                  where b.job_id = v_job and b.batch_no = r.batch_no and b.status = 'cancelled');

  update connect_private.broadcast_job j
     set status = case when j.status = 'queued' then 'cancelled' else j.status end,
         skipped_count = (select count(*) from connect_private.broadcast_recipient r
                           where r.job_id = v_job and r.status = 'skipped'),
         finished_at = case when j.status = 'queued' then now() else j.finished_at end
   where j.id = v_job;

  perform inbox.broadcast_complete(jsonb_build_object('job_id', v_job));
  return jsonb_build_object('cancelled_batches', v_cancelled,
                            'status', (select status from connect_private.broadcast_job where id = v_job));
end $$;

-- ── 8. อ่านข้อมูลลูกค้าให้ CRM (อ่านอย่างเดียว) ────────────────────────
-- ref = core.contact.id — คีย์เดียวกับที่ Connect ส่งไปกับ event ทุกตัว
-- ★ ไม่คืนเคส is_test เว้นแต่ขอมาตรง ๆ · ไม่มี token/secret ใน payload
create or replace function inbox.broadcast_recent_messages(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := nullif(p->>'contact_ref','')::uuid;
        v_limit int := greatest(1, least(coalesce((p->>'limit')::int, 20), 100));
        v_tests boolean := coalesce((p->>'include_test')::boolean, false);
begin
  if v_ref is null then raise exception 'invalid_request' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(s.row order by s.created_at desc)
      from (
        select m.created_at,
               jsonb_build_object(
                 'conversation_id', c.id, 'channel', i.channel,
                 'direction', case when m.sender_type = 'contact' then 'in' else 'out' end,
                 'sender_type', m.sender_type,
                 'responder', m.responder_display_name,
                 'content_type', m.content_type,
                 'text', case when m.content_type = 'text' then m.content else null end,
                 -- ★ path ของสื่อ ไม่ใช่ URL — /media/<path> ของ Connect ต้องมี session
                 --   ของพนักงานถึงจะเปิดได้ CRM ยังดึงรูปตรงไม่ได้ (ดู HANDOFF ข้อค้าง)
                 'media', coalesce((select jsonb_agg(jsonb_build_object(
                                             'path', e->>'path', 'mime', e->>'mime'))
                                      from jsonb_array_elements(
                                             case when jsonb_typeof(m.media) = 'array'
                                                  then m.media else '[]'::jsonb end) e), '[]'::jsonb),
                 'created_at', m.created_at) as row
          from inbox.message m
          join inbox.conversation c on c.id = m.conversation_id
          join inbox.inbox i on i.id = c.inbox_id
         where c.contact_id = v_ref
           and (v_tests or not coalesce(c.is_test, false))
           and m.event_type in ('message', 'postback')
         order by m.created_at desc
         limit v_limit) s), '[]'::jsonb);
end $$;

create or replace function inbox.broadcast_contact_profile(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := nullif(p->>'contact_ref','')::uuid; v_contact core.contact;
begin
  if v_ref is null then raise exception 'invalid_request' using errcode = '22023'; end if;
  select * into v_contact from core.contact where id = v_ref;
  if not found then raise exception 'contact_not_found' using errcode = '42704'; end if;
  return jsonb_build_object(
    'contact_ref', v_contact.id,
    'display_name', v_contact.display_name,
    'picture_url', v_contact.picture_url,
    'blocked', coalesce(v_contact.blocked, false),
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'provider', ci.channel, 'account_scope', ci.account_key,
               'external_id', ci.external_id,
               -- ไม่มีแถวใน channel_follow = ยังไม่เคยเห็น event — null ไม่ใช่ false
               'following', f.following, 'follow_changed_at', f.changed_at)
             order by ci.channel)
        from core.contact_identity ci
        left join connect_private.channel_follow f
          on f.inbox_id::text = ci.account_key and f.external_user_id = ci.external_id
       where ci.contact_id = v_ref), '[]'::jsonb));
end $$;

-- ── 9. สิทธิ์ — service_role เท่านั้น ─────────────────────────────────
-- ★ ห้าม grant ให้ authenticated เด็ดขาด: ทางเข้าคือ /internal/* ที่ยืนยันด้วย
--   CONNECT_SERVICE_TOKEN ไม่ใช่ login ของพนักงาน (BOUNDARIES: หน้าจอ campaign อยู่ที่ CRM)
revoke all on function
  inbox.broadcast_emit(uuid, text, text, text, timestamptz, jsonb),
  inbox.crm_event_id(uuid, text),
  inbox.broadcast_enqueue(jsonb), inbox.broadcast_next_job(jsonb),
  inbox.broadcast_job_start(jsonb), inbox.broadcast_job_fail(jsonb),
  inbox.broadcast_claim_batch(jsonb), inbox.broadcast_batch_finish(jsonb),
  inbox.broadcast_complete(jsonb), inbox.broadcast_status(jsonb), inbox.broadcast_cancel(jsonb),
  inbox.broadcast_recent_messages(jsonb), inbox.broadcast_contact_profile(jsonb)
  from public, anon, authenticated;

grant execute on function
  inbox.broadcast_enqueue(jsonb), inbox.broadcast_next_job(jsonb),
  inbox.broadcast_job_start(jsonb), inbox.broadcast_job_fail(jsonb),
  inbox.broadcast_claim_batch(jsonb), inbox.broadcast_batch_finish(jsonb),
  inbox.broadcast_complete(jsonb), inbox.broadcast_status(jsonb), inbox.broadcast_cancel(jsonb),
  inbox.broadcast_recent_messages(jsonb), inbox.broadcast_contact_profile(jsonb)
  to service_role;

commit;
