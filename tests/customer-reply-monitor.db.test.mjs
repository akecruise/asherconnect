import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const enabled = process.env.ALLOW_DB_TESTS === '1'
const dbTest = (name, fn) => test(name, { skip: !enabled }, fn)

async function sql(statement) {
  const wrapped = `begin; set local request.jwt.claims = '{"role":"service_role"}'; ${statement}; commit;`
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', wrapped], { maxBuffer: 8 << 20 })
  return stdout.split('\n').map(line => line.trim()).filter(line => line && !/^(BEGIN|COMMIT|SET|ROLLBACK|UPDATE|INSERT|DELETE|NOTICE|DROP|CREATE|ALTER|GRANT|REVOKE|NOTIFY)/.test(line))
}

const q = value => `'${String(value).replaceAll("'", "''")}'`

dbTest('episode clock survives duplicate customer messages and bot/failed replies', async () => {
  const ext = `__monitor_${Date.now()}`
  const [inbox] = await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1`)
  const [conversation] = await sql(`
    select (connect_private.reset_test_conversation(jsonb_build_object(
      'inbox_id', ${q(inbox)}, 'channel', 'line', 'external_id', ${q(ext)}
    ))->>'conversation_id')`)
  const t0 = '2026-09-25 08:00:00+00'
  const [row] = await sql(`
    update inbox.conversation set is_test=false where id=${q(conversation)};
    insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,created_at)
      values (${q(conversation)},'contact','ขอราคา','text','message',${q(t0)}),
             (${q(conversation)},'contact','ขอราคาต่อขนาดคะ','text','message','2026-09-25 08:05:00+00'),
             (${q(conversation)},'bot','ตอบอัตโนมัติ','text','message','2026-09-25 08:06:00+00');
    select row_to_json(x) from (
      select reply_episode_message_id, asked_at, raw_waiting_minutes
        from inbox.pending_reply_snapshot('2026-09-25 10:01:00+00', 20)
       where conversation_id=${q(conversation)}
    ) x;
    delete from connect_private.delivery where message_id in (select id from inbox.message where conversation_id=${q(conversation)});
    delete from inbox.conversation where id=${q(conversation)};
  `)
  const parsed = JSON.parse(row)
  assert.equal(parsed.asked_at, '2026-09-25T08:00:00+00:00')
  assert.equal(parsed.raw_waiting_minutes, 121)
})

dbTest('successful ASHER reply closes the episode, failed reply does not', async () => {
  const ext = `__monitor_success_${Date.now()}`
  const [inbox] = await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1`)
  const [conversation] = await sql(`select (connect_private.reset_test_conversation(jsonb_build_object('inbox_id',${q(inbox)},'channel','line','external_id',${q(ext)}))->>'conversation_id')`)
  const out = await sql(`
    update inbox.conversation set is_test=false where id=${q(conversation)};
    insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,created_at)
      values (${q(conversation)},'contact','ราคาเท่าไหร่','text','message','2026-09-25 08:00:00+00');
    with x as (
      insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,created_at)
        values (${q(conversation)},'agent','คำตอบที่ส่งไม่สำเร็จ','text','message','2026-09-25 08:10:00+00') returning id
    ) select id from x;
  `)
  const failedMessage = out.at(-1)
  await sql(`update connect_private.delivery set status='failed' where message_id=${q(failedMessage)}`)
  const [stillPending] = await sql(`select count(*) from inbox.pending_reply_snapshot('2026-09-25 10:00:00+00',20) where conversation_id=${q(conversation)}`)
  assert.equal(stillPending, '1')

  const [sentMessage] = await sql(`insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,created_at)
    values (${q(conversation)},'agent','คำตอบที่ส่งสำเร็จ','text','message','2026-09-25 08:11:00+00') returning id`)
  await sql(`update connect_private.delivery set status='sent' where message_id=${q(sentMessage)};
             select connect_private.mark_human_reply(${q(conversation)},null,'workspace','2026-09-25 08:11:01+00');`)
  const [closed] = await sql(`select count(*) from inbox.pending_reply_snapshot('2026-09-25 10:00:00+00',20) where conversation_id=${q(conversation)}`)
  assert.equal(closed, '0')
  await sql(`delete from connect_private.delivery where message_id in (select id from inbox.message where conversation_id=${q(conversation)});
             delete from inbox.conversation where id=${q(conversation)}`)
})

dbTest('Business Suite/page echo is accepted as a human answer', async () => {
  const ext = `__monitor_echo_${Date.now()}`
  const [inbox] = await sql(`select id from inbox.inbox where channel='messenger' and is_active order by created_at limit 1`)
  if (!inbox) return
  const [conversation] = await sql(`select (connect_private.reset_test_conversation(jsonb_build_object('inbox_id',${q(inbox)},'channel','messenger','external_id',${q(ext)}))->>'conversation_id')`)
  const eventAt = '2026-09-25 08:12:00+00'
  await sql(`
    update inbox.conversation set is_test=false where id=${q(conversation)};
    insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,created_at)
      values (${q(conversation)},'contact','ขอรายละเอียด','text','message','2026-09-25 08:00:00+00'),
             (${q(conversation)},'agent','ได้เลยค่ะ','text','message',${q(eventAt)});
    insert into inbox.human_reply_events(conversation_id,source,note,created_at)
      values (${q(conversation)},'page_inbox','Business Suite echo',${q(eventAt)});
  `)
  const [pending] = await sql(`select count(*) from inbox.pending_reply_snapshot('2026-09-25 10:00:00+00',20) where conversation_id=${q(conversation)}`)
  assert.equal(pending, '0')
  await sql(`delete from connect_private.delivery where message_id in (select id from inbox.message where conversation_id=${q(conversation)});
             delete from inbox.conversation where id=${q(conversation)}`)
})

dbTest('watchdog deduplicates by episode and cancels an unsent alert after reply', async (t) => {
  const ext = `__monitor_watchdog_${Date.now()}`
  const [inbox] = await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1`)
  const [watchdogConfig = 'false|120'] = await sql(`
    select coalesce((select value::text from inbox.bot_config where inbox_id=${q(inbox)} and key='notify.watchdog.enabled'),'false') || '|' ||
           coalesce((select value::text from inbox.bot_config where inbox_id=${q(inbox)} and key='notify.watchdog.after_min'),'120')`)
  const [previousEnabled, previousAfterMin] = watchdogConfig.split('|')
  t.after(async () => {
    await sql(`
      insert into inbox.bot_config(inbox_id,key,value) values
        (${q(inbox)},'notify.watchdog.enabled',${q(previousEnabled)}::jsonb),
        (${q(inbox)},'notify.watchdog.after_min',${q(previousAfterMin)}::jsonb)
      on conflict (inbox_id,key) do update set value=excluded.value`)
  })
  const [conversation] = await sql(`select (connect_private.reset_test_conversation(jsonb_build_object('inbox_id',${q(inbox)},'channel','line','external_id',${q(ext)}))->>'conversation_id')`)
  await sql(`
    update inbox.conversation set is_test=false where id=${q(conversation)};
    insert into inbox.bot_config(inbox_id,key,value) values (${q(inbox)},'notify.watchdog.enabled','true'),(${q(inbox)},'notify.watchdog.after_min','1')
      on conflict (inbox_id,key) do update set value=excluded.value;
    insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,created_at)
      values (${q(conversation)},'contact','ค้างแจ้งเตือน','text','message','2026-09-25 08:00:00+00');
    select inbox.watchdog('2026-09-25 10:00:00+00');
    select inbox.watchdog('2026-09-25 10:00:01+00');
  `)
  const [counts] = await sql(`select (select count(*) from inbox.reply_alert where conversation_id=${q(conversation)}) || '|' ||
    (select count(*) from connect_private.job where conversation_id=${q(conversation)} and kind='notify')`)
  assert.equal(counts, '1|1')
  await sql(`select connect_private.mark_human_reply(${q(conversation)},null,'workspace','2026-09-25 10:01:00+00')`)
  const [cancelled] = await sql(`select (select count(*) from inbox.reply_alert where conversation_id=${q(conversation)} and status='cancelled') || '|' ||
    (select count(*) from connect_private.job where conversation_id=${q(conversation)} and kind='notify' and status='skipped')`)
  assert.equal(cancelled, '1|1')
  await sql(`delete from connect_private.delivery where message_id in (select id from inbox.message where conversation_id=${q(conversation)});
             delete from connect_private.job where conversation_id=${q(conversation)};
             delete from inbox.reply_alert where conversation_id=${q(conversation)};
             delete from inbox.conversation where id=${q(conversation)}`)
})

dbTest('LINE OA reply backfill is idempotent and closes only the answered episode', async () => {
  const ext = `__monitor_line_oa_${Date.now()}`
  const [inbox] = await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1`)
  const [conversation] = await sql(`select (connect_private.reset_test_conversation(jsonb_build_object('inbox_id',${q(inbox)},'channel','line','external_id',${q(ext)}))->>'conversation_id')`)
  const [episode] = await sql(`
    update inbox.conversation set is_test=false where id=${q(conversation)};
    insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,external_message_id,created_at)
      values (${q(conversation)},'contact','ขอราคาต่อขนาดค่ะ','text','message','line-customer-1','2026-09-25 08:00:00+00') returning id;
  `)
  await sql(`
    insert into inbox.reply_alert(conversation_id,reply_episode_message_id,alert_level,status)
      values (${q(conversation)},${q(episode)},'sla','pending');
    select connect_private.backfill_line_oa_reply(${q(inbox)},${q(ext)},'ลูกค้า LINE','line-agent-1',
      '2026-09-25 08:05:00+00','owner-1','เซลล์ LINE');
    select connect_private.backfill_line_oa_reply(${q(inbox)},${q(ext)},'ลูกค้า LINE','line-agent-1',
      '2026-09-25 08:05:00+00','owner-1','เซลล์ LINE');
  `)
  const [result] = await sql(`select json_build_object(
    'agent_messages',(select count(*) from inbox.message where conversation_id=${q(conversation)} and sender_type='agent' and external_message_id='line-agent-1'),
    'events',(select count(*) from inbox.human_reply_events where conversation_id=${q(conversation)} and source='line_oa_backfill' and external_event_id='line-agent-1'),
    'pending',(select count(*) from inbox.pending_reply_snapshot('2026-09-25 09:00:00+00',20) where conversation_id=${q(conversation)}),
    'cancelled',(select count(*) from inbox.reply_alert where conversation_id=${q(conversation)} and status='cancelled'))`)
  assert.deepEqual(JSON.parse(result), { agent_messages: 1, events: 1, pending: 0, cancelled: 1 })
  await sql(`delete from connect_private.delivery where message_id in (select id from inbox.message where conversation_id=${q(conversation)});
             delete from connect_private.job where conversation_id=${q(conversation)};
             delete from inbox.reply_alert where conversation_id=${q(conversation)};
             delete from inbox.conversation where id=${q(conversation)}`)
})

dbTest('out-of-order LINE OA reply does not close a newer customer episode', async () => {
  const ext = `__monitor_line_oa_order_${Date.now()}`
  const [inbox] = await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1`)
  const [conversation] = await sql(`select (connect_private.reset_test_conversation(jsonb_build_object('inbox_id',${q(inbox)},'channel','line','external_id',${q(ext)}))->>'conversation_id')`)
  const [episode] = await sql(`
    update inbox.conversation set is_test=false where id=${q(conversation)};
    insert into inbox.message(conversation_id,sender_type,content,content_type,event_type,external_message_id,created_at)
      values (${q(conversation)},'contact','ข้อความรอบใหม่','text','message','line-customer-new','2026-09-25 08:10:00+00') returning id;
  `)
  await sql(`
    insert into inbox.reply_alert(conversation_id,reply_episode_message_id,alert_level,status)
      values (${q(conversation)},${q(episode)},'sla','pending');
    select connect_private.backfill_line_oa_reply(${q(inbox)},${q(ext)},'ลูกค้า LINE','line-agent-old',
      '2026-09-25 08:05:00+00','owner-1','เซลล์ LINE');
  `)
  const [result] = await sql(`select json_build_object(
    'pending',(select count(*) from inbox.pending_reply_snapshot('2026-09-25 09:00:00+00',20) where conversation_id=${q(conversation)}),
    'alert_status',(select status from inbox.reply_alert where conversation_id=${q(conversation)} limit 1))`)
  assert.deepEqual(JSON.parse(result), { pending: 1, alert_status: 'pending' })
  await sql(`delete from connect_private.delivery where message_id in (select id from inbox.message where conversation_id=${q(conversation)});
             delete from connect_private.job where conversation_id=${q(conversation)};
             delete from inbox.reply_alert where conversation_id=${q(conversation)};
             delete from inbox.conversation where id=${q(conversation)}`)
})
