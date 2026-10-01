import test from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {verifySignature,normalizeWebhook,normalizeEvents,renderPayload,payloadText,matchesDestination,deliver} from '../providers.mjs'
test('LINE signatures use unmodified bytes and base64; Messenger uses prefixed hex',()=>{
 const body=Buffer.from('{"message":"สวัสดี"}'),secret='test-secret'
 assert.equal(verifySignature(body,createHmac('sha256',secret).update(body).digest('base64'),secret,'line'),true)
 assert.equal(verifySignature(body,'sha256='+createHmac('sha256',secret).update(body).digest('hex'),secret,'messenger'),true)
 assert.equal(verifySignature(Buffer.concat([body,Buffer.from(' ')]),createHmac('sha256',secret).update(body).digest('base64'),secret,'line'),false)
 assert.equal(verifySignature(body,'',secret,'line'),false)
})
test('provider echo is not an inbound customer response',()=>{
 const data={object:'page',entry:[{id:'page',messaging:[{sender:{id:'u'},timestamp:1000,message:{mid:'m',is_echo:true,text:'bot'}}]}]}
 assert.deepEqual(normalizeWebhook('messenger',data,{account_id:'page'}),[])
})
test('LINE rejects a signed event addressed to a different account',()=>{
 assert.throws(()=>normalizeWebhook('line',{destination:'other',events:[]},{account_id:'ours'}),/destination/)
})
test('LINE retries carry stable idempotency key and accept previously accepted request',async()=>{
 const job={message_id:'key',lease_id:'lease',channel:'line',recipient:'u',text:'Hi'}
 let headers
 const r=await deliver(job,{access_token:'secret'},async(url,init)=>{headers=init.headers;return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}})})
 assert.equal(headers['X-Line-Retry-Key'],'key');assert.equal(r.status,'sent');assert.equal(r.provider_id,'accepted')
})
test('Messenger unknown transport outcome is not automatically retried',async()=>{
 const job={channel:'messenger',recipient:'u',last_inbound_at:new Date().toISOString(),text:'Hi'}
 const r=await deliver(job,{account_id:'page',access_token:'secret'},async()=>{throw Error('timeout')})
 assert.equal(r.status,'uncertain')
})
test('Messenger closes standard reply after 24 hours without calling provider',async()=>{
 const r=await deliver({channel:'messenger',recipient:'u',last_inbound_at:'2020-01-01'}, {},()=>{throw Error('must not call')})
 assert.equal(r.status,'failed');assert.equal(r.error,'messenger_24h_window_closed')
})
test('Instagram sends text through the Instagram Messages endpoint',async()=>{
 let called
 const job={channel:'instagram',recipient:'IGSID-1',last_inbound_at:new Date().toISOString(),text:'ใบเสนอราคา https://example.com/q.pdf'}
 const result=await deliver(job,{account_id:'17841426509548035',api_version:'v23.0',access_token:'secret'},async(url,init)=>{
  called={url,body:JSON.parse(init.body)}
  return new Response(JSON.stringify({message_id:'ig-mid'}),{status:200,headers:{'content-type':'application/json'}})
 })
 assert.equal(called.url,'https://graph.instagram.com/v23.0/17841426509548035/messages')
 assert.deepEqual(called.body,{recipient:{id:'IGSID-1'},message:{text:'ใบเสนอราคา https://example.com/q.pdf'}})
 assert.equal(result.status,'sent')
 assert.equal(result.provider_id,'ig-mid')
})
test('definite rejection fails; rate limit retries without stopping SLA',async()=>{
 for(const [status,result] of [[400,'failed'],[429,'retry']]){
 const r=await deliver({channel:'line',recipient:'u',text:'Hi'}, {access_token:'x'},async()=>new Response('{}',{status}))
 assert.equal(r.status,result)
 }
})

test('ทุก event ที่ผ่าน normalize มี event_type ติดมาด้วยเสมอ',()=>{
 // บอทตัดสินใจจากชนิดของเหตุการณ์ ไม่ใช่จากเนื้อความ — "กดปุ่มดูห้อง" กับ "พิมพ์ว่าดูห้อง" คนละเรื่อง
 const body={destination:'ours',events:[
  {type:'message',webhookEventId:'e1',timestamp:1000,source:{type:'user',userId:'u'},message:{id:'m1',type:'text',text:'สวัสดี'}},
  {type:'postback',webhookEventId:'e2',timestamp:1000,source:{type:'user',userId:'u'},postback:{data:'action=room&id=1'}},
  {type:'follow',webhookEventId:'e3',timestamp:1000,source:{type:'user',userId:'u'}},
 ]}
 const out=normalizeWebhook('line',body,{account_id:'ours',inbox_id:'ib'})
 assert.deepEqual(out.map(e=>e.event_type),['message','postback','follow'])
 assert.equal(out[1].text.includes('action=room&id=1'),true)
 assert.equal(out.every(e=>e.event_id&&e.inbox_id==='ib'),true)
})

test('postback ของ Messenger ที่ไม่มี mid ยังได้คีย์กันซ้ำที่คงที่',()=>{
 const body={object:'page',entry:[{id:'page',messaging:[
  {sender:{id:'u'},timestamp:1700000000000,postback:{title:'ดูห้อง',payload:'ROOM_1BR'}}]}]}
 const a=normalizeWebhook('messenger',body,{account_id:'page',inbox_id:'ib'})
 const b=normalizeWebhook('messenger',body,{account_id:'page',inbox_id:'ib'})
 assert.equal(a[0].event_type,'postback')
 assert.equal(a[0].event_id,b[0].event_id)  // ยิงซ้ำก้อนเดิมต้องได้คีย์เดิม ไม่งั้นด่านกันซ้ำที่ฐานไม่ทำงาน
})

test('ของที่ normalize ไม่รู้จัก ถูกข้าม ไม่ใช่ทำให้ทั้งก้อนล้ม',()=>{
 const body={destination:'ours',events:[
  {type:'ชนิดใหม่ของผู้ให้บริการ',webhookEventId:'e9',timestamp:1000,source:{type:'user',userId:'u'}},
  {type:'message',webhookEventId:'e8',timestamp:1000,source:{type:'user',userId:'u'},message:{id:'m',type:'text',text:'ยังเข้าได้'}}]}
 const out=normalizeWebhook('line',body,{account_id:'ours',inbox_id:'ib'})
 assert.equal(out.length,1)
 assert.equal(out[0].event_type,'message')
})

test('ส่งผิดบ้านต้องรู้ก่อนเก็บของดิบ',()=>{
 assert.equal(matchesDestination('line',{destination:'ours'},{account_id:'ours'}),true)
 assert.equal(matchesDestination('line',{destination:'other'},{account_id:'ours'}),false)
 assert.equal(matchesDestination('messenger',{object:'page',entry:[{id:'page'}]},{account_id:'page'}),true)
 assert.equal(matchesDestination('messenger',{object:'page',entry:[{id:'อื่น'}]},{account_id:'page'}),false)
})

test('payload ขาออกเป็น JSON จึงส่งได้มากกว่าข้อความล้วน',()=>{
 assert.deepEqual(renderPayload('line',{type:'text',text:'สวัสดี'}),{type:'text',text:'สวัสดี'})
 assert.deepEqual(renderPayload('messenger',{type:'text',text:'สวัสดี'}),{text:'สวัสดี'})

 const lineImage=renderPayload('line',{type:'image',url:'https://x/a.jpg'})
 assert.equal(lineImage.type,'image')
 assert.equal(lineImage.previewImageUrl,'https://x/a.jpg')  // ไม่ได้ส่ง preview มา ใช้รูปเดียวกันแทน ไม่ใช่ค่าว่าง

 const lineQuick=renderPayload('line',{type:'text',text:'เลือกได้เลย',quick_replies:[{label:'1 นอน',payload:'BR1'}]})
 assert.equal(lineQuick.quickReply.items[0].action.data,'BR1')
 const fbQuick=renderPayload('messenger',{type:'text',text:'เลือกได้เลย',quick_replies:[{label:'1 นอน',payload:'BR1'}]})
 assert.equal(fbQuick.quick_replies[0].payload,'BR1')

 // ทางออกสำหรับของที่ยังไม่มีชนิดรองรับ เช่น flex ของ LINE
 assert.deepEqual(renderPayload('line',{type:'raw',line:{type:'flex',altText:'ก'}}),{type:'flex',altText:'ก'})
})

test('payload ที่ไม่รู้จักตกลงมาเป็นข้อความล้วน ไม่ใช่ส่งไม่ออก',()=>{
 // ลูกค้าไม่ได้ยินอะไรเลย แย่กว่าได้ยินแบบธรรมดา
 assert.deepEqual(renderPayload('line',{},'ข้อความสำรอง'),{type:'text',text:'ข้อความสำรอง'})
 assert.deepEqual(renderPayload('line',null,'ข้อความสำรอง'),{type:'text',text:'ข้อความสำรอง'})
 assert.deepEqual(renderPayload('messenger',{type:'raw'},'ข้อความสำรอง'),{text:'ข้อความสำรอง'})
})

test('deliver ใช้ payload จากคิว ไม่ใช่เนื้อความดิบ',async()=>{
 let sent
 const job={message_id:'k',lease_id:'l',channel:'line',recipient:'u',text:'เนื้อความในตาราง',
            payload:{type:'text',text:'สิ่งที่ต้องส่งจริง',quick_replies:[{label:'ดูห้อง',payload:'ROOM'}]}}
 await deliver(job,{access_token:'x'},async(url,init)=>{sent=JSON.parse(init.body);return new Response('{}',{status:200})})
 assert.equal(sent.messages[0].text,'สิ่งที่ต้องส่งจริง')
 assert.equal(sent.messages[0].quickReply.items[0].action.label,'ดูห้อง')
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — รับ event ให้ครบ และส่งออกได้ทุกช่องทาง
//
// fixture ข้างล่างเป็นรูปร่างจริงของ payload ที่ Meta/LINE ส่งมา
// (ประกอบจากที่ edge function เดิมอ่านจริง + เอกสารของผู้ให้บริการ)
// ตอนนี้ connect_private.webhook_log ยังว่าง เพราะยังไม่เปิดรับ traffic จริง
// วันที่มีของจริงแล้ว ให้แทน fixture พวกนี้ด้วยก้อนที่ดักได้จริง แล้วเทสต์ต้องยังผ่าน
// ═══════════════════════════════════════════════════════════════════════════

const FB = {account_id:'100000000000001', inbox_id:'ib-fb'}
const LN = {account_id:'Uline-bot-destination', inbox_id:'ib-line'}
const page = (...items)=>({object:'page',entry:[{id:FB.account_id,time:1757836800000,...items.reduce((a,b)=>({...a,...b}),{})}]})
const lineBody = (...events)=>({destination:LN.account_id,events})

test('Messenger: echo ของคนที่ตอบจาก Business Suite',()=>{
 // เพจเป็นคนส่ง ปลายทางจึงอยู่ที่ recipient — ถ้าอ่าน sender จะได้ id ของเพจ ไม่ใช่ของลูกค้า
 const body=page({messaging:[{sender:{id:FB.account_id},recipient:{id:'PSID-1'},timestamp:1757836800000,
   message:{mid:'m_echo_1',is_echo:true,text:'สวัสดีค่ะ ห้องว่างอยู่นะคะ -มิ้นท์'}}]})
 const [ev]=normalizeEvents('messenger',body,FB)
 assert.equal(ev.event_type,'echo')
 assert.equal(ev.external_id,'PSID-1')
 assert.equal(ev.app_id,null)          // ไม่มี app_id = กดส่งจากหน้า Page Inbox
 assert.equal(ev.text.includes('มิ้นท์'),true)
})

test('Messenger: echo ของบอทเราเอง แยกออกจาก echo ของคนด้วย app_id',()=>{
 const body=page({messaging:[{sender:{id:FB.account_id},recipient:{id:'PSID-1'},timestamp:1757836800000,
   message:{mid:'m_echo_2',is_echo:true,app_id:1234567890,text:'ขอบคุณค่ะ'}}]})
 const [ev]=normalizeEvents('messenger',body,FB)
 assert.equal(ev.event_type,'echo')
 assert.equal(ev.app_id,'1234567890')  // เป็นสตริงเสมอ เทียบกับ env ได้ตรง ๆ ไม่ต้องแปลงทีหลัง
})

test('Messenger: standby คือข้อความของลูกค้าจริง แต่เพจไม่ใช่เจ้าของ thread',()=>{
 const body=page({standby:[{sender:{id:'PSID-2'},recipient:{id:FB.account_id},timestamp:1757836800000,
   message:{mid:'m_sb_1',text:'ราคาเท่าไหร่คะ'}}]})
 const [ev]=normalizeEvents('messenger',body,FB)
 assert.equal(ev.event_type,'message')
 assert.equal(ev.is_standby,true)      // ธงนี้คือสิ่งเดียวที่ห้ามบอทตอบ
 assert.equal(ev.external_id,'PSID-2')
 const normal=normalizeEvents('messenger',page({messaging:[{sender:{id:'PSID-3'},recipient:{id:FB.account_id},
   timestamp:1757836800000,message:{mid:'m1',text:'สวัสดี'}}]}),FB)
 assert.equal(normal[0].is_standby,false)
})

test('Messenger: คลิกโฆษณาแล้วยังไม่พิมพ์อะไร ก็ยังเป็นเหตุการณ์ที่ต้องรู้',()=>{
 const body=page({messaging:[{sender:{id:'PSID-4'},recipient:{id:FB.account_id},timestamp:1757836800000,
   referral:{ref:'ad',source:'ADS',type:'OPEN_THREAD',ad_id:'120210000000000',
     ads_context_data:{ad_title:'Asher Naii พร้อมอยู่ 2.39 ลบ.'}}}]})
 const [ev]=normalizeEvents('messenger',body,FB)
 assert.equal(ev.event_type,'referral')
 assert.equal(ev.ad_id,'120210000000000')
 assert.equal(ev.ad_title,'Asher Naii พร้อมอยู่ 2.39 ลบ.')
 assert.equal(ev.event_id.startsWith('ref:'),true)   // ไม่มี mid มาให้ ต้องประกอบคีย์เองให้คงที่
})

test('Messenger: ข้อความแรกที่มาจากโฆษณา พา ad_id ติดมาด้วย',()=>{
 const body=page({messaging:[{sender:{id:'PSID-5'},recipient:{id:FB.account_id},timestamp:1757836800000,
   message:{mid:'m_ad_1',text:'สนใจค่ะ'},
   referral:{ad_id:'120211111111111',ads_context_data:{ad_title:'1 ห้องนอน 27 ตร.ม.'}}}]})
 const [ev]=normalizeEvents('messenger',body,FB)
 assert.equal(ev.event_type,'message')
 assert.equal(ev.ad_id,'120211111111111')
 assert.equal(ev.ad_title,'1 ห้องนอน 27 ตร.ม.')
})

test('Messenger: postback ที่มาจากโฆษณา ได้ทั้งปุ่มและที่มา',()=>{
 const body=page({messaging:[{sender:{id:'PSID-6'},recipient:{id:FB.account_id},timestamp:1757836800000,
   postback:{mid:'m_pb_1',title:'ดูราคา',payload:'PRICE_1BR',
     referral:{ad_id:'120212222222222',ads_context_data:{ad_title:'โปรเดือนนี้'}}}}]})
 const [ev]=normalizeEvents('messenger',body,FB)
 assert.equal(ev.event_type,'postback')
 assert.equal(ev.event_id,'m_pb_1')
 assert.equal(ev.ad_id,'120212222222222')
 assert.equal(ev.text.includes('ดูราคา'),true)
})

test('Messenger: read / delivery receipt ไม่ใช่เหตุการณ์ของบทสนทนา',()=>{
 const body=page({messaging:[
   {sender:{id:'PSID-7'},recipient:{id:FB.account_id},timestamp:1757836800000,read:{watermark:1757836800000}},
   {sender:{id:'PSID-7'},recipient:{id:FB.account_id},timestamp:1757836800000,delivery:{mids:['m1'],watermark:1}}]})
 assert.deepEqual(normalizeEvents('messenger',body,FB),[])
})

test('echo ต้องถึง receive ด้วย ไม่ใช่ถูกกรองทิ้ง',()=>{
 // receive() รู้วิธีจัดการ echo แล้ว (บันทึกเป็นข้อความของฝั่งเรา ไม่ใช่ของลูกค้า)
 // และ last_human_reply_at ที่ได้จาก echo คือค่าที่ decide_reply ใช้ตัดสินว่าคนรับช่วงไปแล้ว
 const body=page({messaging:[
   {sender:{id:FB.account_id},recipient:{id:'PSID-8'},timestamp:1757836800000,message:{mid:'e1',is_echo:true,text:'ตอบแล้วค่ะ'}},
   {sender:{id:'PSID-8'},recipient:{id:FB.account_id},timestamp:1757836800001,message:{mid:'c1',text:'ขอบคุณค่ะ'}}]})
 const forReceive=normalizeWebhook('messenger',body,FB)
 assert.deepEqual(forReceive.map(e=>e.event_type),['echo','message'])
 assert.equal(forReceive[0].external_id,'PSID-8')   // ปลายทางคือลูกค้า ไม่ใช่เพจ
})

test('บอทถูกเชิญเข้ากลุ่ม (join) ยังไม่ต้องทำอะไร นอกจากเก็บไว้',()=>{
 const body=lineBody({type:'join',webhookEventId:'01J-j9',timestamp:1757836800000,
   source:{type:'group',groupId:'Cg1'},replyToken:'rt'})
 assert.equal(normalizeEvents('line',body,LN)[0].event_type,'join')
 assert.deepEqual(normalizeWebhook('line',body,LN),[])   // join ไม่เข้า receive
})

test('LINE: ตอบด้วย reply token เมื่อยังไม่หมดอายุ · เลยเวลาแล้วใช้ push',async()=>{
 const c1=capture()
 await deliver({kind:'send',channel:'line',target:'U1',payload:{type:'text',text:'ทันเวลา'},
   reply_token:'rt-1',reply_token_age_sec:3,reply_token_max_sec:20},{access_token:'t'},c1.fetcher)
 assert.equal(c1.seen.url,'https://api.line.me/v2/bot/message/reply')
 assert.equal(c1.seen.body.replyToken,'rt-1')
 assert.equal('to' in c1.seen.body,false)

 const c2=capture()
 await deliver({kind:'send',channel:'line',target:'U1',payload:{type:'text',text:'สายไป'},
   reply_token:'rt-2',reply_token_age_sec:45,reply_token_max_sec:20},{access_token:'t'},c2.fetcher)
 assert.equal(c2.seen.url,'https://api.line.me/v2/bot/message/push')
 assert.equal(c2.seen.body.to,'U1')

 // ไม่มี token มาเลยก็ push
 const c3=capture()
 await deliver({kind:'send',channel:'line',target:'U1',payload:{type:'text',text:'ไม่มี token'}},
   {access_token:'t'},c3.fetcher)
 assert.equal(c3.seen.url,'https://api.line.me/v2/bot/message/push')
})

test('push โดน 403 = ลูกค้าบล็อกแล้ว ต้องติดธงให้ชั้นบนรู้ ไม่ใช่ลองใหม่เรื่อย ๆ',async()=>{
 const r=await deliver({kind:'send',channel:'line',target:'U1',payload:{type:'text',text:'สวัสดี'}},
   {access_token:'t'},async()=>new Response('{}',{status:403}))
 assert.equal(r.status,'failed')
 assert.equal(r.error,'line_recipient_blocked')
 assert.equal(r.blocked,true)
})

test('LINE: ข้อความในกลุ่มคือทีมสั่งงาน ไม่ใช่ลูกค้า — เก็บไว้แต่ไม่เข้า receive',()=>{
 const body=lineBody({type:'message',webhookEventId:'01J-group-1',timestamp:1757836800000,
   source:{type:'group',groupId:'Cgroup123',userId:'Usales1'},replyToken:'rt-group',
   message:{id:'lm-g1',type:'text',text:'ตอบแล้ว a1b2c3 มิ้นท์'}})
 const [ev]=normalizeEvents('line',body,LN)
 assert.equal(ev.event_type,'group_command')
 assert.equal(ev.group_id,'Cgroup123')
 assert.equal(ev.external_id,'Usales1')
 assert.equal(ev.text,'ตอบแล้ว a1b2c3 มิ้นท์')
 assert.equal(ev.reply_token,'rt-group')
 // ตั้งแต่ Phase 6 คำสั่งกลุ่มต้องถึง receive เพราะฐานเป็นคนแปลคำสั่ง
 const forReceive=normalizeWebhook('line',body,LN)
 assert.equal(forReceive.length,1)
 assert.equal(forReceive[0].event_type,'group_command')
 assert.equal(forReceive[0].group_id,'Cgroup123')
})

test('LINE: บอทถูกเชิญเข้ากลุ่ม',()=>{
 const body=lineBody({type:'join',webhookEventId:'01J-join-1',timestamp:1757836800000,
   source:{type:'group',groupId:'Cgroup999'},replyToken:'rt-join'})
 const [ev]=normalizeEvents('line',body,LN)
 assert.equal(ev.event_type,'join')
 assert.equal(ev.group_id,'Cgroup999')
})

test('LINE: ของที่ผู้ให้บริการยิงซ้ำ ติดธงไว้และไม่ต้องทำงานซ้ำ',()=>{
 const body=lineBody({type:'message',webhookEventId:'01J-re-1',timestamp:1757836800000,
   source:{type:'user',userId:'Ucust1'},replyToken:'rt1',
   deliveryContext:{isRedelivery:true},message:{id:'lm-r1',type:'text',text:'ราคาเท่าไหร่'}})
 const [ev]=normalizeEvents('line',body,LN)
 assert.equal(ev.is_redelivery,true)
 assert.deepEqual(normalizeWebhook('line',body,LN),[])
})

test('LINE: reply_token ติดมากับ event และหมดอายุเร็ว จึงต้องส่งต่อไปชั้นที่ส่งของ',()=>{
 const body=lineBody({type:'message',webhookEventId:'01J-rt-1',timestamp:1757836800000,
   source:{type:'user',userId:'Ucust2'},replyToken:'0f3779689fb94a5b9d0e7c3f2b1a4c5d',
   message:{id:'lm-1',type:'text',text:'สนใจห้อง 1 นอน'}})
 const [ev]=normalizeEvents('line',body,LN)
 assert.equal(ev.reply_token,'0f3779689fb94a5b9d0e7c3f2b1a4c5d')
 assert.equal(ev.source_type,'user')
})

test('LINE: สติกเกอร์กับโลเคชั่นไม่ใช่ข้อความ แต่ต้องอ่านออกในหน้าจอ',()=>{
 const body=lineBody(
   {type:'message',webhookEventId:'01J-st',timestamp:1757836800000,source:{type:'user',userId:'U1'},
    message:{id:'lm-st',type:'sticker',packageId:'446',stickerId:'1988'}},
   {type:'message',webhookEventId:'01J-lo',timestamp:1757836800000,source:{type:'user',userId:'U1'},
    message:{id:'lm-lo',type:'location',title:'Asher Naii',address:'อินทามระ 41',latitude:13.8,longitude:100.56}})
 const [st,lo]=normalizeEvents('line',body,LN)
 assert.equal(st.content_type,'sticker')
 assert.equal(st.attribution.sticker.stickerId,'1988')
 assert.equal(lo.content_type,'location')
 assert.equal(lo.text.includes('อินทามระ 41'),true)
})

// ── ส่งของออก: kind + payload + ช่องทางที่เพิ่มมา ────────────────────────────
const okRes = (body='{}') => async()=>new Response(body,{status:200})
const capture = () => { const seen={}; return {seen, fetcher: async(url,init)=>{seen.url=url;seen.init=init;seen.body=JSON.parse(init.body);return new Response('{}',{status:200})}} }

test('ส่งเข้ากลุ่ม LINE ใช้ push เหมือนกัน แต่ปลายทางเป็น groupId',async()=>{
 const c=capture()
 const r=await deliver({kind:'notify',channel:'line_group',target:'Cgroup123',payload:{type:'text',text:'มีคนทัก'}},
   {access_token:'line-token'},c.fetcher)
 assert.equal(r.status,'sent')
 assert.equal(c.seen.url,'https://api.line.me/v2/bot/message/push')
 assert.equal(c.seen.body.to,'Cgroup123')
 assert.equal(c.seen.body.messages[0].text,'มีคนทัก')
})

test('Telegram ส่งด้วย chat_id จาก target และ token จาก config ไม่ใช่จาก env',async()=>{
 const c=capture()
 const r=await deliver({kind:'notify',channel:'telegram',target:'-1001234567890',payload:{text:'สรุปวันนี้'}},
   {telegram_bot_token:'123:ABC'},c.fetcher)
 assert.equal(r.status,'sent')
 assert.equal(c.seen.url,'https://api.telegram.org/bot123:ABC/sendMessage')
 assert.equal(c.seen.body.chat_id,'-1001234567890')
 assert.equal(c.seen.body.text,'สรุปวันนี้')
})

test('Email ส่งผ่าน Resend · ถ้าไม่ได้ให้ html มา ส่งเป็นข้อความล้วน',async()=>{
 const c=capture()
 await deliver({kind:'notify',channel:'email',target:'sales@asher.local',
   payload:{subject:'Lead ใหม่',text:'เบอร์ 0812345678'}},
   {resend_api_key:'re_x',email_from:'bot@asher.local'},c.fetcher)
 assert.equal(c.seen.url,'https://api.resend.com/emails')
 assert.equal(c.seen.body.from,'bot@asher.local')
 assert.deepEqual(c.seen.body.to,['sales@asher.local'])
 assert.equal(c.seen.body.subject,'Lead ใหม่')
 assert.equal(c.seen.body.text,'เบอร์ 0812345678')
 assert.equal('html' in c.seen.body,false)
})


test('typing: messenger ล้ม → skipped · line สำเร็จ → ยิงถูก endpoint',async()=>{
 const r=await deliver({kind:'typing',channel:'messenger',target:'PSID-1'},
   {account_id:'PAGE',access_token:'t'},async()=>new Response('{}',{status:500}))
 assert.equal(r.status,'skipped')
 const ln=capture()
 const r2=await deliver({kind:'typing',channel:'line',target:'U1'},{access_token:'t'},ln.fetcher)
 assert.equal(r2.status,'sent')
 assert.equal(ln.seen.url,'https://api.line.me/v2/bot/chat/loading/start')
 assert.equal(ln.seen.body.chatId,'U1')
})

test('งานแจ้งทีมผ่าน Messenger ไม่ติดกฎหน้าต่าง 24 ชม. ของการตอบลูกค้า',async()=>{
 const r=await deliver({kind:'notify',channel:'messenger',target:'PSID-ADMIN',payload:{type:'text',text:'แจ้ง'}},
   {account_id:'PAGE',access_token:'t'},okRes('{"message_id":"mid.1"}'))
 assert.equal(r.status,'sent')
 assert.equal(r.provider_id,'mid.1')
})

test('ไม่มี token ต้องบอกตรง ๆ ว่าขาดอะไร ไม่ใช่ยิงออกไปด้วย Bearer undefined',async()=>{
 const boom=async()=>{throw new Error('ต้องไม่ถูกเรียก')}
 assert.equal((await deliver({channel:'line',target:'U1'},{},boom)).error,'line_token_missing')
 assert.equal((await deliver({kind:'notify',channel:'telegram',target:'c'},{},boom)).error,'telegram_token_missing')
 assert.equal((await deliver({kind:'notify',channel:'email',target:'a@b.c'},{},boom)).error,'resend_key_missing')
})

test('ช่องทางที่ยังไม่รองรับ ต้องปฏิเสธ ไม่ใช่เงียบแล้วนับว่าส่งแล้ว',async()=>{
 const r=await deliver({kind:'send',channel:'sms',target:'0812345678'},{},async()=>{throw new Error('ต้องไม่ถูกเรียก')})
 assert.equal(r.status,'failed')
 assert.equal(r.error,'channel_not_supported')
})

test('ผลลัพธ์จากปลายทางแปลเป็นสถานะของคิวถูกต้องทุกช่องทาง',async()=>{
 const res=s=>async()=>new Response('{}',{status:s})
 const status=async(channel,s)=>(await deliver({kind:'notify',channel,target:'x'},
   {access_token:'t',account_id:'PAGE',telegram_bot_token:'t'},res(s))).status
 assert.equal(await status('line',429),'retry')
 assert.equal(await status('line',500),'retry')          // มี retry key ยิงซ้ำปลอดภัย
 assert.equal(await status('telegram',500),'retry')      // ทีมเห็นซ้ำยังดีกว่าไม่เห็น
 assert.equal(await status('messenger',500),'uncertain') // ไม่มี idempotency key → ให้คนดู
 assert.equal(await status('messenger',400),'failed')
})

test('LINE ตอบ 403 แปลว่าลูกค้าบล็อกแล้ว ไม่ใช่ error ทั่วไป',async()=>{
 const r=await deliver({kind:'send',channel:'line',target:'U1',payload:{type:'text',text:'สวัสดี'}},
   {access_token:'t'},async()=>new Response('{}',{status:403}))
 assert.equal(r.status,'failed')
 assert.equal(r.error,'line_recipient_blocked')
})

test('payloadText ดึงข้อความจาก payload ได้ทุกทรง',()=>{
 assert.equal(payloadText({text:'ก'}),'ก')
 assert.equal(payloadText({message:'ข'}),'ข')
 assert.equal(payloadText('ค'),'ค')
 assert.equal(payloadText(null,'สำรอง'),'สำรอง')
})
