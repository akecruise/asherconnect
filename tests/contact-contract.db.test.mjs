import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { extractCustomerContact } from '../lib/customer-contact-extraction.mjs'

// Explicit isolated engine path: never connects to the configured Supabase DB.
if (!process.env.PGLITE_MODULE) throw new Error('Set PGLITE_MODULE to an isolated @electric-sql/pglite@0.3.14 dist/index.js; see docs/contact-contract-fix.md')
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href)
const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
let db
test.before(async () => {
 db = new PGlite()
 await db.exec(await read('./fixtures/contact-contract.sql'))
 await db.exec(await read('../sql/022_contact_profile_sync.sql'))
 await db.exec(await read('../sql/202609211200_messenger_identity_p0.sql'))
 const instagram = await read('../sql/20260923090119_instagram_inbox.sql')
 await db.exec(instagram.slice(0,instagram.indexOf('$migration$;')+'$migration$;'.length))
 const worker = await read('../sql/202609221400_manual_name_guard.sql')
 await db.exec(worker.slice(worker.indexOf('CREATE OR REPLACE FUNCTION connect_private.worker'),worker.indexOf('end $function$;')+'end $function$;'.length))
 await db.exec(await read('../sql/202609240100_crm_profile_updated_all_channels.sql'))
 await db.exec(await read('../sql/202609221200_crm_publish_profile_content.sql'))
 await db.exec('create trigger contact_contract_message after insert on inbox.message for each row execute function inbox.crm_publish_message()')
 if (!process.env.CONTRACT_BASELINE) {
   const order = (await read('../sql/ORDER.txt')).split(/\r?\n/)
   for (const f of order.filter(f => f.endsWith('_contact_receive_contract.sql'))) await db.exec(await read('../sql/' + f))
 }
 await db.exec(`insert into inbox.inbox(id,channel) values ('${A}','messenger'),('${B}','messenger');`)
})
test.after(async () => { await db?.close() })
async function seed(psid, scope=A, fields={}) {
 const { rows:[c] } = await db.query('insert into core.contact(display_name,phone,extra) values ($1,$2,$3) returning id',
  [fields.name ?? null, fields.phone ?? null, JSON.stringify(fields.extra ?? {})])
 await db.query('insert into core.contact_identity(contact_id,channel,account_key,external_id) values ($1,$2,$3,$4)',[c.id,'messenger',scope,psid])
 return c.id
}
async function receive(psid, text, event=crypto.randomUUID(), scope=A, extra={}) {
 const signal = extractCustomerContact(text)
 return (await db.query('select connect_private.receive_event($1::jsonb,now()) as result',[JSON.stringify({
  inbox_id:scope,page_id:'PAGE_'+scope,customer_psid:psid,external_id:psid,source_type:'user',event_id:event,
  event_type:'message',text,extracted_name:signal.name,extracted_phone:signal.phone,...extra
 })])).rows[0].result
}
async function contact(id) { return (await db.query('select * from core.contact where id=$1',[id])).rows[0] }
test('Node extraction reaches contact and durable CRM payload; replay is idempotent', async () => {
 const id=await seed('customer'); const event=crypto.randomUUID()
 await receive('customer','ชื่อ: สมชาย โทร 0812345678',event)
 assert.equal((await contact(id)).display_name,'สมชาย')
 assert.equal((await contact(id)).phone,'0812345678')
 const rows=(await db.query('select payload from inbox.crm_publish_outbox where aggregate_id=$1',[id])).rows
 assert.ok(rows.some(r=>r.payload.phone==='0812345678' && r.payload.display_name==='สมชาย'))
 const messages=(await db.query("select payload from inbox.crm_publish_outbox where event_type='message.received' and payload->>'external_id'='customer'")).rows
 assert.equal(messages.length,1)
 assert.equal(messages[0].payload.phone,'0812345678')
 assert.equal(messages[0].payload.display_name,'สมชาย')
 assert.equal(messages[0].payload.account_scope,A)
 assert.equal((await receive('customer','ชื่อ: ผิด โทร 0899999999',event)).duplicate,true)
 assert.equal((await contact(id)).display_name,'สมชาย')
})
test('profile name writes are scoped and unscoped calls fail closed',async()=>{
 const a=await seed('shared',A); const b=await seed('shared',B)
 const payload={channel:'messenger',account_key:B,people:[{external_id:'shared',name:'Page B'}]}
 await db.query('select inbox.sync_contact_profile($1)',[JSON.stringify(payload)])
 assert.equal((await contact(a)).display_name,null)
 assert.equal((await contact(b)).display_name,'Page B')
 delete payload.account_key
 await assert.rejects(db.query('select inbox.sync_contact_profile($1)',[JSON.stringify(payload)]),/account_scope_required/)
})
test('manual name and existing phone survive; phone-only updates publish',async()=>{
 const id=await seed('manual',A,{name:'Verified',extra:{name_source:'manual'}})
 await receive('manual','ชื่อ: Replacement โทร 0891234567')
 assert.equal((await contact(id)).display_name,'Verified')
 assert.equal((await contact(id)).phone,'0891234567')
 assert.ok((await db.query('select payload from inbox.crm_publish_outbox where aggregate_id=$1',[id])).rows.some(r=>r.payload.phone==='0891234567'))
 await receive('manual','โทร 0812345678')
 assert.equal((await contact(id)).phone,'0891234567')
})
test('blank/invalid fields and non-user messages do not populate a contact',async()=>{
 const id=await seed('invalid')
 await receive('invalid','12345678901234567',undefined,A,{extracted_phone:'12345678901234567',extracted_name:' '})
 assert.equal((await contact(id)).phone,null)
 assert.equal((await contact(id)).display_name,null)
 await receive('invalid','ชื่อ: Agent โทร 0812345678',undefined,A,{source_type:'page'})
 assert.equal((await contact(id)).phone,null)
 assert.equal((await contact(id)).display_name,null)
})
test('platform refresh cannot overwrite customer supplied name',async()=>{
 const id=await seed('customer-name')
 await receive('customer-name','ชื่อ: สมชาย')
 await db.query('select connect_private.worker($1,$2)', ['profile_update',JSON.stringify({
  channel:'messenger',account_key:A,external_id:'customer-name',display_name:'Platform Name',status:'ok'
 })])
 assert.equal((await contact(id)).display_name,'สมชาย')
})
test('anonymized contacts cannot be restored by receive or profile sync',async()=>{
 const id=await seed('erased')
 await db.query('update core.contact set anonymized_at=now() where id=$1',[id])
 await receive('erased','ชื่อ: สมชาย โทร 0812345678')
 await db.query('select inbox.sync_contact_profile($1)',[JSON.stringify({channel:'messenger',account_key:A,people:[{external_id:'erased',name:'Platform'}]})])
 assert.equal((await contact(id)).display_name,null)
 assert.equal((await contact(id)).phone,null)
 assert.equal((await db.query('select count(*)::int as n from inbox.crm_publish_outbox where aggregate_id=$1',[id])).rows[0].n,0)
})
test('outbox failure rolls back receive so webhook replay can recover',async()=>{
 const id=await seed('retry'); const event=crypto.randomUUID()
 await db.exec(`create function inbox.reject_contract_outbox() returns trigger language plpgsql as $$ begin raise exception 'test_outbox_unavailable'; end $$;
 create trigger reject_contract before insert on inbox.crm_publish_outbox for each row execute function inbox.reject_contract_outbox();`)
 try {
  await assert.rejects(receive('retry','ชื่อ: สมชาย โทร 0812345678',event),/test_outbox_unavailable/)
  assert.equal((await contact(id)).phone,null)
  assert.equal((await db.query('select count(*)::int as n from connect_private.inbound_event where event_id=$1',[event])).rows[0].n,0)
 } finally { await db.exec('drop trigger reject_contract on inbox.crm_publish_outbox; drop function inbox.reject_contract_outbox();') }
 await receive('retry','ชื่อ: สมชาย โทร 0812345678',event)
 assert.equal((await contact(id)).phone,'0812345678')
})
test('receive scopes identical external ids to the selected inbox',async()=>{
 const a=await seed('same-receive',A); const b=await seed('same-receive',B)
 await receive('same-receive','ชื่อ: สมชาย โทร 0812345678',undefined,B)
 assert.equal((await contact(a)).phone,null)
 assert.equal((await contact(b)).phone,'0812345678')
})
test('migration preserves Instagram identity and inbox-scoped echo matching; privileges stay closed',async()=>{
 const {rows:[row]}=await db.query("select pg_get_functiondef('connect_private.receive_event(jsonb,timestamptz,integer)'::regprocedure) as body")
 assert.match(row.body,/if v_inbox.channel in \('messenger', 'instagram'\) then/)
 assert.match(row.body,/dc.inbox_id=v_inbox.id/)
 for (const role of ['anon','authenticated']) {
  const {rows:[p]}=await db.query("select has_function_privilege($1,'inbox.sync_contact_profile(jsonb)','EXECUTE') as allowed",[role])
  assert.equal(p.allowed,false)
 }
 const order=(await read('../sql/ORDER.txt')).split(/\r?\n/)
 for(const f of order.filter(f=>f.endsWith('_contact_receive_contract.sql'))) await db.exec(await read('../sql/'+f))
})
