import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const dbTest = (name, fn) => test(name, { skip: SKIP }, fn)
const TAG = '__messenger_identity_p0__' + Date.now()
const PAGE = 'PAGE_1'
const A = TAG + '_PSID_A'
const B = TAG + '_PSID_B'
const REVIEW = TAG + '_META_REVIEW_PSID'

async function sql(text) {
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'supabase_admin', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c',
    `begin; ${text} commit;`], { maxBuffer: 16 << 20 })
  return stdout.split(/\r?\n/).map(s => s.trim())
    .filter(Boolean)
    .filter(s => !['BEGIN', 'COMMIT', 'SET'].includes(s))
}

let inbox

dbTest('Messenger PSID isolation, echo safety, and unresolved identity boundary', async () => {
  inbox = (await sql("select id from inbox.inbox where channel='messenger' and is_active order by created_at limit 1;"))[0]
  assert.ok(inbox, 'active Messenger inbox is required')
  const project = (await sql(`select project_id from inbox.inbox where id='${inbox}';`))[0]
  assert.ok(project)

  const seeded = await sql(`select core.resolve_identity('messenger','${A}','${inbox}','Same Display Name','${project}');`)
  assert.equal(seeded.length, 1)

  const send = async (eventId, eventType, psid, text) => {
    const data = JSON.stringify({
      inbox_id: inbox, page_id: PAGE, customer_psid: psid, external_id: psid,
      event_id: TAG + '_' + eventId, event_type: eventType, text,
      display_name: 'Same Display Name', occurred_at: '2026-09-21T00:00:00Z',
      is_standby: true,
    }).replace(/'/g, "''")
    return JSON.parse((await sql(`select connect_private.receive_event('${data}'::jsonb, '2026-09-21T00:00:00Z');`))[0])
  }

  const a1 = await send('a1', 'message', A, 'A one')
  const b1 = await send('b1', 'message', B, 'B one')
  assert.notEqual(a1.id, b1.id, 'PSID_A and PSID_B must use separate conversations')
  const a2 = await send('a2', 'message', A, 'A two')
  assert.equal(a2.id, a1.id, 'same PSID must reuse its conversation')

  const pageInbound = await send('page', 'message', PAGE, 'bad page identity')
  assert.equal(pageInbound.error, 'IDENTITY_UNRESOLVED')
  assert.equal((await sql(`select count(*) from core.contact_identity where channel='messenger' and account_key='${inbox}' and external_id='${PAGE}';`))[0], '0')

  const beforeEchoContacts = (await sql(`select count(*) from core.contact_identity where channel='messenger' and account_key='${inbox}';`))[0]
  const echo = await send('echo_a', 'echo', A, 'agent reply')
  assert.equal(echo.id, a1.id, 'echo must attach to PSID_A conversation')
  assert.equal((await sql(`select count(*) from core.contact_identity where channel='messenger' and account_key='${inbox}';`))[0], beforeEchoContacts)

  const review = await send('review', 'message', REVIEW, 'review identity')
  assert.notEqual(review.id, a1.id, 'Meta review identity must remain isolated')

  const unresolved = await send('echo_missing', 'echo', TAG + '_MISSING', 'ambiguous echo')
  assert.equal(unresolved.error, 'IDENTITY_UNRESOLVED')
  assert.equal((await sql(`select count(*) from inbox.conversation c join core.contact_identity ci on ci.contact_id=c.contact_id and ci.channel='messenger' and ci.account_key='${inbox}' and ci.external_id like '${TAG}_%' where c.inbox_id='${inbox}';`))[0], '3')

  const pageEcho = await send('echo_page', 'echo', PAGE, 'reversed echo')
  assert.equal(pageEcho.error, 'IDENTITY_UNRESOLVED')
  assert.equal((await sql(`select count(*) from core.contact_identity where channel='messenger' and account_key='${inbox}' and external_id='${PAGE}';`))[0], '0')
})

test.after(async () => {
  if (!inbox) return
  await sql(`
    create temp table messenger_identity_test_contacts on commit drop as
      select distinct contact_id
      from core.contact_identity
      where channel = 'messenger'
        and account_key = '${inbox}'
        and left(external_id, length('${TAG}')) = '${TAG}';

    create temp table messenger_identity_test_conversations on commit drop as
      select c.id
      from inbox.conversation c
      join messenger_identity_test_contacts tc on tc.contact_id = c.contact_id
      where c.inbox_id = '${inbox}';

    create temp table messenger_identity_test_leads on commit drop as
      select distinct l.id
      from crm.lead l
      join messenger_identity_test_contacts tc on tc.contact_id = l.contact_id;

    -- inbound_event.message_id is SET NULL, but remove the test events first.
    delete from connect_private.inbound_event
    where left(event_id, length('${TAG}')) = '${TAG}';

    -- These conversation children are RESTRICT, so remove them before the
    -- conversation. Cascading children are then handled by the FK itself.
    delete from answer_hub.answer_feedback f
    using messenger_identity_test_conversations tc
    where f.conversation_id = tc.id;
    delete from answer_hub.answer_usage u
    using messenger_identity_test_conversations tc
    where u.conversation_id = tc.id;
    delete from answer_hub.learning_candidate l
    using messenger_identity_test_conversations tc
    where l.conversation_id = tc.id;
    delete from connect_private.case_state s
    using messenger_identity_test_conversations tc
    where s.conversation_id = tc.id;
    delete from crm.activity a
    using messenger_identity_test_conversations tc
    where a.conversation_id = tc.id;
    delete from inbox.quick_reply_usage u
    using messenger_identity_test_conversations tc
    where u.conversation_id = tc.id;

    delete from inbox.conversation c
    using messenger_identity_test_conversations tc
    where c.id = tc.id;

    -- Remove any lead/contact dependents created by ensure_lead/receive_event.
    delete from crm.activity a
    using messenger_identity_test_leads tl
    where a.lead_id = tl.id;
    delete from web.web_form_submit w
    using messenger_identity_test_leads tl
    where w.lead_id = tl.id;
    delete from web.web_form_submit w
    using messenger_identity_test_contacts tc
    where w.contact_id = tc.contact_id;
    delete from campaign.touch t
    using messenger_identity_test_contacts tc
    where t.contact_id = tc.contact_id;
    delete from core.event_log e
    using messenger_identity_test_contacts tc
    where e.contact_id = tc.contact_id;
    delete from engage.participant p
    using messenger_identity_test_contacts tc
    where p.contact_id = tc.contact_id;

    delete from crm.lead l
    using messenger_identity_test_leads tl
    where l.id = tl.id;
    delete from core.contact_identity ci
    using messenger_identity_test_contacts tc
    where ci.contact_id = tc.contact_id;
    delete from core.contact c
    using messenger_identity_test_contacts tc
    where c.id = tc.contact_id;
  `)
})

