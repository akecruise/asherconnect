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
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
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
  await sql(`delete from connect_private.inbound_event where event_id like '${TAG}_%';`)
  await sql(`delete from inbox.conversation where inbox_id='${inbox}' and contact_id in (select contact_id from core.contact_identity where channel='messenger' and account_key='${inbox}' and external_id like '${TAG}_%');`)
  await sql(`delete from core.contact_identity where channel='messenger' and account_key='${inbox}' and external_id like '${TAG}_%';`)
})
