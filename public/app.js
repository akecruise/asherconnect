import { slaTag } from './sla.mjs'
import { TAG_COLORS, TAG_COLOR_NAMES, tagColor, isFlagFilter, flagListArgs, followPresets, followBadge, cardTags, matchTags, tagDiff, STAGES, stageOf, slaBadge, CHANNELS, contactsQuery, bulkSummary } from './case-flags.mjs'

const $ = id => document.getElementById(id)
// หน้ารายชื่อติดต่อใช้เปลือกและเซสชันเดียวกับหน้าแชท (server เสิร์ฟ index.html ที่ /contacts)
const CONTACTS_VIEW = location.pathname === '/contacts'
const labels={mine:'งานของฉัน',unassigned:'ยังไม่มีคนรับ',waiting:'รอลูกค้าตอบ',sla:'ตอบเกิน SLA',today:'นัดหมายวันนี้',followup:'ถึงเวลาติดตาม',closed:'ปิดแล้ว',all:'ทั้งหมด'}
const channelState={ok:'รับข้อความอยู่',idle:'เงียบเกิน 24 ชั่วโมง',down:'มีปัญหา',off:'ยังไม่ได้เชื่อม',unknown:'ตรวจสถานะไม่ได้'}
const stageNames={follow_up:'ติดตาม',qualified:'Qualified',appointment:'นัดชม',walk_in:'Walk-in',booking:'Booking',sale:'Sale',lost:'ปิดแล้ว'}
const errors={invalid_credentials:'อีเมลหรือรหัสผ่านไม่ถูกต้อง',too_many_attempts:'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาที',not_allowed:'บัญชีของระบบไม่มีสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแล',session_expired:'เชื่อมต่อระบบหลังบ้านไม่ได้ กรุณารีเฟรชหน้า',channel_not_configured:'ยังไม่ได้เชื่อมบัญชีช่องทางนี้ กรุณาติดต่อผู้ดูแล',already_assigned:'มีผู้รับเคสนี้แล้ว กรุณารีเฟรช',claim_required:'กรุณารับเคสก่อนทำรายการ',version_conflict:'ข้อมูลถูกแก้ไขจากอีกหน้าจอ กรุณาเลือกเคสใหม่แล้วตรวจข้อมูล',stage_transition_not_allowed:'กรุณาดำเนินการตามลำดับสถานะ',future_appointment_required:'กรุณาเลือกวันเวลานัดในอนาคต',unit_unavailable:'ห้องนี้ไม่พร้อมจอง',booking_required:'ต้องมีใบจองก่อนบันทึก Sale',case_closed:'เคสนี้ปิดแล้ว',service_unavailable:'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่',request_rejected:'บันทึกไม่สำเร็จ กรุณาตรวจข้อมูลและลำดับสถานะ',invalid_origin:'กรุณาเปิดผ่าน URL ที่ผู้ดูแลกำหนด',shadow_mode:'ตอนนี้ระบบอยู่ในโหมดเก็บข้อมูล ยังไม่เปิดให้ส่งข้อความหาลูกค้า'}
let boot,items=[],selected=null,detail=null,filter='unassigned',offset=0,busy=false,dirty=false,sequence=0,listSequence=0,polling=false
// Small bridge for the optional Quick Replies module; no credentials or service
// role data are exposed, only the already-authorized bootstrap result.
window.asherQuickReplies = () => boot?.quick_replies?.length ? boot.quick_replies : (boot?.canned ?? [])
const drafts=new Map(),pendingCommands=new Map()
// ดาว/tag/ติดตาม ของเคสในหน้าที่โหลดอยู่ (inbox.case_flags) + รายการ tag ของทีม (inbox.tags_list)
let flags={},tagState={tags:[],starred:0,can_manage:false,can_create:false}
const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e}
function note(value,error=false){$('notice').hidden=!value;$('notice').textContent=value;$('notice').className='notice'+(error?' error':'')}
async function request(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){if(response.status===401&&path==='/api/command'&&boot){dirty=false;$('message').value='';location.replace('/')}const e=new Error(errors[data.error]||'ทำรายการไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่');e.code=data.error;throw e}return data}
const api=(action,data={})=>request('/api/command',{action,data})
const date=value=>value?new Date(value).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'medium',timeStyle:'short'}):'—'
function local(value){if(!value)return '';return new Date(new Date(value).getTime()+7*3600000).toISOString().slice(0,16)}
const utc=value=>value?new Date(value+':00+07:00').toISOString():null
// ─────────────────────────────────────────── เทมเพลตข้อความ (เฟส 4.2)
//
// ★ ตัวแปรที่แทนได้ต้องมีแหล่งจริงเท่านั้น
//   {ชื่อ}        <- ชื่อลูกค้าที่บันทึกไว้ (ไม่มีชื่อ = ไม่แทน)
//   {โครงการ}     <- ชื่อโครงการที่เลือกอยู่
//   {ราคาเริ่มต้น} <- ราคาต่ำสุดของห้องที่ยังว่างใน inventory.unit
//
// ★★ ถ้าไม่มีค่า "ห้ามแทนด้วยอะไรทั้งนั้น" ให้คงวงเล็บไว้แล้วเตือนคนส่ง
//    ตอนนี้ inventory.unit ว่างทั้งสองโครงการ และ bots/project-data/naii.md
//    ยังมีหมายเหตุของทีมเองว่า "⚠️ ต้องยืนยัน ... On Top 300,000 หรือ 350,000"
//    การเดาตัวเลขให้ = เซลส์กดส่งราคาผิดให้ลูกค้าโดยไม่รู้ตัว ซึ่งเรียกคืนไม่ได้
//    ปล่อยให้เห็นวงเล็บค้างอยู่ คนพิมพ์จะสังเกตเองก่อนกดส่ง
const TEMPLATE_VARS = ['ชื่อ', 'โครงการ', 'ราคาเริ่มต้น']

function templateValues(){
 const project = boot?.projects?.find(x => x.id === $('project').value)
 const price = project?.starting_price
 return {
  'ชื่อ': (detail?.contact?.display_name ?? '').trim() || null,
  'โครงการ': project?.name ?? null,
  'ราคาเริ่มต้น': price != null ? Number(price).toLocaleString('th-TH') + ' บาท' : null,
 }
}

/** แทนค่าตัวแปร · คืนทั้งข้อความและรายชื่อตัวแปรที่แทนไม่ได้ */
function fillTemplate(content){
 const v = templateValues()
 const missing = []
 const text = String(content ?? '').replace(/\{([^}]+)\}/g, (whole, name) => {
  const key = name.trim()
  if (!TEMPLATE_VARS.includes(key)) return whole
  if (v[key] == null) { if (!missing.includes(key)) missing.push(key); return whole }
  return v[key]
 })
 return { text, missing }
}

// จุดแทรกข้อความเดียวสำหรับ Quick Reply ทั้งจากปุ่มและ /shortcut
window.asherInsertQuickReply = (item, range, { focus = true } = {}) => {
 const message = $('message')
 const { text: content, missing } = fillTemplate(item?.content ?? item?.body ?? '')
 const start = range?.start ?? message.selectionStart ?? message.value.length
 const end = range?.end ?? message.selectionEnd ?? message.value.length
 message.value = message.value.slice(0, start) + content + message.value.slice(end)
 message.dispatchEvent(new Event('input', { bubbles: true }))
 if (focus) message.focus()
 if (missing.length) note('ยังไม่มีข้อมูลสำหรับ ' + missing.map(m => '{' + m + '}').join(' ') + ' — กรุณาเติมเองก่อนส่ง', true)
}

// เปิดหน้าต่างเลือกห้องทันทีพร้อมสถานะกำลังโหลด แล้วค่อยเติมห้องว่างจาก CRM ตามมา
// (เดิมรอ CRM ตอบก่อนค่อยเปิด — ระหว่างนั้นหน้าจอนิ่ง เซลส์คิดว่ากดไม่ติด)
// หนึ่งห้องต่อหนึ่งใบเสนอราคา · จำรายการห้องไว้สั้น ๆ ให้เปิดซ้ำได้ทันที
// รูปเป็นใบเสนอราคาสำเร็จรูปต่อห้องที่เซิร์ฟเวอร์ทำรอไว้แล้ว — กดส่งแล้วขึ้นแชททันที ไม่ต้องรอ CRM วาดรูป
// ห้องที่ยังไม่มีราคา (รอราคา) ออกใบเสนอราคาไม่ได้ จึงไม่แสดง
const QUOTE_UNITS_TTL_MS=60_000
let quoteUnitsCache=null
async function exportAvailableUnitsPng(){
 if(!detail||!selected||busy)return
 const conversation=selected
 dialog('ส่งใบเสนอราคา',[{name:'unit_id',label:'ห้องว่าง',options:[{value:'',label:'กำลังโหลดห้องว่างจาก CRM…'}]}],'quotation_png',{submitLabel:'ส่งใบเสนอราคาเข้าแชท'})
 const select=$('dialog-fields').querySelector('select[name="unit_id"]')
 select.disabled=true;$('dialog-submit').disabled=true
 const stillOpen=()=>$('dialog').open&&dialogAction==='quotation_png'&&selected===conversation
 try{
  const fresh=quoteUnitsCache&&quoteUnitsCache.id===conversation&&Date.now()-quoteUnitsCache.at<QUOTE_UNITS_TTL_MS
  const units=(fresh?quoteUnitsCache.units:await api('quotation_units',{id:conversation})).filter(u=>Number(u.price)>0)
  if(!fresh)quoteUnitsCache={id:conversation,at:Date.now(),units}
  if(!stillOpen())return
  if(!units.length){$('dialog').close();note('CRM ยังไม่มีห้องว่างที่มีราคาสำหรับออกใบเสนอราคา',true);return}
  const label=u=>`${u.project_name} · ห้อง ${u.unit_number} · ${u.floor_name||'ไม่ระบุชั้น'} · ${Number(u.price||0).toLocaleString('th-TH')} บาท`
  select.replaceChildren(...units.map(u=>{const option=text('option',label(u));option.value=u.id;option.dataset.unitNumber=u.unit_number;return option}))
  select.disabled=false;$('dialog-submit').disabled=busy
 }catch(error){if(stillOpen())$('dialog-error').textContent=`โหลดห้องว่างไม่สำเร็จ: ${error.message}`}
}

async function generateUnitQuotation(unitId){
 if(!detail||!selected||busy||!unitId)return
 const conversation=selected,submit=$('dialog-submit'),submitLabel=submit.textContent
 const unitNumber=$('dialog-fields').querySelector(`option[value="${CSS.escape(unitId)}"]`)?.dataset.unitNumber||''
 submit.textContent='กำลังส่ง…'
 setBusy(true)
 try{
  await api('quotation_unit_png',{id:conversation,unit_id:unitId})
  $('dialog').close()
  note(`ส่งใบเสนอราคาห้อง ${unitNumber} เข้าแชทแล้ว`)
 }catch(error){
  $('dialog-error').textContent=error.message==='unit_unavailable'?'ห้องนี้ไม่ว่างแล้ว กรุณาเลือกห้องอื่น':`ส่งใบเสนอราคาไม่สำเร็จ: ${error.message}`
  if(error.message==='unit_unavailable')quoteUnitsCache=null
  return
 }finally{submit.textContent=submitLabel;setBusy(false)}
 // รูปใบเสนอราคาจะโผล่ในแชทเอง — โหลดแชท/รายการเบื้องหลัง ไม่ล็อกปุ่มรอ
 if(selected===conversation)api('detail',{id:conversation}).then(d=>{if(selected===conversation){detail=d;renderDetail()}}).catch(()=>{})
 loadList().catch(()=>{})
}
window.asherExportAvailableUnitsPng=exportAvailableUnitsPng

// ชื่อที่จะโชว์ให้เซลส์เห็น — กฎเดียว ใช้ทั้งการ์ดในรายการและหัวแชท
//   มีชื่อจริง        -> ชื่อ
//   ไม่มีชื่อ           -> external id (PSID ของ Facebook / userId ของ LINE)
//   ไม่มีทั้งคู่         -> 'ลูกค้าใหม่'
// ★ "ไม่มีชื่อ" นับรวมกรณีที่ค่าเป็นคำว่า 'ลูกค้าใหม่' ด้วย
//   เพราะเคยมีของหลุดเข้าฐานจากตอนที่หน้าจอเอาคำนี้ไปใส่ช่องแก้ชื่อแล้วกดบันทึก
//   ถ้าไม่ดัก ลูกค้าคนนั้นจะชื่อ "ลูกค้าใหม่" ตลอดไปและหา external id ดูไม่ได้เลย
const NO_NAME = 'ลูกค้าใหม่'
const CHANNEL_WORD = { line: 'LINE', messenger: 'Messenger' }
// ★ ไม่โชว์ id เต็มบนการ์ดอีกแล้ว — userId ของ LINE ยาว 33 ตัว ตัดแล้วเหลือ "U666f06…"
//   ซึ่งแยกคนไม่ออกและกินที่ทั้งแถว · id เต็มย้ายไปอยู่ในหน้ารายละเอียดพร้อมปุ่มคัดลอก
function customerName(name, externalId, channel){
 const n = (name ?? '').trim()
 if (n && n !== NO_NAME) return n
 const id = (externalId ?? '').trim()
 if (!id) return NO_NAME
 return 'ลูกค้า ' + (CHANNEL_WORD[channel] || 'แชท') + ' ···' + id.slice(-4)
}
// ตัวอักษรย่อไว้ใช้ตอนไม่มีรูปหรือรูปโหลดไม่ขึ้น
function initials(label){
 const t = (label ?? '').trim()
 if (!t) return '?'
 const w = t.split(/\s+/).filter(Boolean)
 return (w.length > 1 ? w[0][0] + w[1][0] : t.slice(0, 2)).toUpperCase()
}
// รูปเล็กหน้าการ์ด — ★ URL ของ Messenger มีวันหมดอายุ รูปพังเป็นเรื่องปกติ ไม่ใช่บั๊ก
//   จึงต้องมีตัวอักษรย่อรออยู่ข้างหลังเสมอ ไม่ใช่ปล่อยให้เป็นกรอบว่าง
function avatar(url, label){
 const box = text('span', '', 'avatar')
 box.textContent = initials(label)
 if (url) {
  const img = document.createElement('img')
  img.alt = ''
  img.loading = 'lazy'
  img.addEventListener('error', () => img.remove())
  img.src = url
  box.append(img)
 }
 return box
}

// ★ สถานะมาจาก inbox.case_status ในฐานที่เดียว (sql/023) หน้าจอไม่คิดเองอีกแล้ว
// ของเดิมคิดจาก waiting_since ฝั่งเบราว์เซอร์ ซึ่งเป็นค่าที่ "หายได้" — บทสนทนาที่ไม่เคยมีแถว
// ใน case_state จะได้ค่าว่าง แล้วหัวแชทขึ้นว่า "ตอบแล้ว" ทั้งที่ลูกค้าทักค้างอยู่
// อีกอย่างที่ฝั่งเบราว์เซอร์ทำไม่ได้เลยคือหักช่วงหยุดนับ 00:00-06:00 ออก
function sla(cs){
 if(!cs||!cs.case_status)return{label:'',style:''}
 const m=Number(cs.waiting_minutes||0)
 // สีตามกติกาแบรนด์: เทาคือปกติ · แดงอ่อนคือยังไม่ตอบ · แดงเข้มคือเกิน SLA เท่านั้น
 if(cs.case_status==='closed')return{label:'ปิดแล้ว',style:''}
 if(cs.case_status==='wait')return{label:'รอลูกค้าตอบ',style:''}
 if(cs.case_status==='late')return{label:'เกิน SLA '+m+' นาที',style:'critical'}
 return{label:'ยังไม่ตอบ '+m+' นาที',style:'red'}
}

// ── แท็กสถานะบนการ์ดเคส ─────────────────────────────────────────────
// ★ ที่เดียวที่ผูกสถานะกับสี — เพิ่มสถานะใหม่ = เพิ่มบรรทัดเดียวในตารางนี้
//   คีย์คือ case_status จากฐาน (sql/023) ไม่ใช่ข้อความที่เห็นบนจอ
//   เพราะข้อความมีจำนวนนาทีต่อท้าย ("ยังไม่ตอบ 12 นาที") เอามาเป็นคีย์ไม่ได้
//   'replied' ยังไม่มีในฐาน ใส่ไว้ล่วงหน้าตามดีไซน์ ("ตอบแล้ว" = น้ำเงิน)
//   ★ แดงยังสงวนไว้ให้ "ยังไม่ตอบ"/"เกิน SLA" เหมือนเดิม ตามกติกาสีแบรนด์
const STATUS_TONE={closed:'green',wait:'amber',replied:'blue',open:'red',late:'crit'}
const statusTone=code=>STATUS_TONE[code]||'gray'

// แจ้งเตือนกำหนดการย้ายขึ้นมาอยู่บรรทัดแรกแล้ว จึงต้องสั้นพอที่จะไม่ดันชื่อลูกค้าจนหาย
// ★ ข้อความเต็มไม่ได้หายไปไหน — อยู่ใน title (hover) และใน .sr-only ให้โปรแกรมอ่านหน้าจอ
const ALERT_SHORT={'ถึงเวลานัดหมาย':'นัดหมาย','ติดตามเลยกำหนด':'ติดตาม'}

// เวลาบนการ์ด — วันนี้ HH:mm · เมื่อวาน "เมื่อวาน" · เก่ากว่านั้น d MMM
// ★ เทียบกันที่ "วันตามปฏิทินกรุงเทพ" ไม่ใช่ผลต่างมิลลิวินาที
//   23:50 กับ 00:10 ห่างกัน 20 นาทีแต่คนละวัน ต้องขึ้น "เมื่อวาน" ไม่ใช่เวลา
const bkkDay=v=>new Date(v).toLocaleDateString('en-CA',{timeZone:'Asia/Bangkok'})
function listTime(value){
 if(!value)return ''
 const d=new Date(value);if(Number.isNaN(d.getTime()))return ''
 const now=Date.now(),day=bkkDay(d)
 if(day===bkkDay(now))return d.toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
 if(day===bkkDay(now-86400000))return 'เมื่อวาน'
 return d.toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short'})
}

// ★ ติดตามเลยกำหนดไม่อยู่ในนี้แล้ว — มีป้าย ⏰ สีอำพันของตัวเอง (การ์ด + บล็อกการติดตาม) ตาม spec ดาว/tag
//   ป้ายในนี้เป็นสีแดง ถ้าคงไว้จะซ้ำกันสองป้ายและเป็นแดงที่สงวนไว้ให้ SLA
function dueAlerts(state,closed=false){if(closed)return [];const now=Date.now();return [['appointment_at','ถึงเวลานัดหมาย']].filter(([key])=>state[key]&&Date.parse(state[key])<=now).map(([,label])=>label)}
function renderDue(state,closed){let box=$('due-alerts');if(!box){box=text('div','','case-alerts');box.id='due-alerts';$('appointment-summary').after(box)}box.replaceChildren(...dueAlerts(state,closed).map(label=>text('span',label,'pill red')))}
let countSequence=0;
// ตัวนับ SLA ตัวเก่าถูกเอาออก — มันไล่ขอรายการทีละหน้ามานับเองที่เบราว์เซอร์
// ยิ่งเคสเยอะยิ่งช้า และได้มาแค่ตัวเดียว — ย้ายไปนับที่ฐานทีเดียวด้วย inbox.queue_counts() (sql/024)

function setBusy(value){busy=value;for(const id of ['claim','send','save','transfer','appointment','close','dialog-submit'])$(id).disabled=value;for(const b of $('pipeline').querySelectorAll('button'))b.disabled=value;if(!value&&detail)permissions()}
// ★ ตอบลูกค้าได้เสมอโดยไม่ต้องรับเคส — ทีมใช้คิวรวม ไม่มีเจ้าของเคสรายคน
// แต่ "แก้ข้อมูลลูกค้า/เลื่อนสถานะดีล" ยังต้องรับเคสก่อน เพราะเจ้าของดีลต้องมีคนเดียว
// ด่านจริงอยู่ที่ connect_private.api (sql/025) ตรงนี้แค่ทำให้หน้าจอตรงกับด่านนั้น
function permissions(){
 const c=detail.conversation
 const open=c.status!=='resolved'
 const canReply=open
 const canEdit=open&&(c.assignee_id===boot.user.id||['manager','admin'].includes(boot.user.role)&&c.assignee_id)
 $('claim').hidden=!!c.assignee_id||!open
 $('transfer').hidden=!['manager','admin','senior_sales'].includes(boot.user.role)||!c.assignee_id||!open
 for(const id of ['send','message'])$(id).disabled=busy||!canReply
 for(const id of ['save','appointment','close'])$(id).disabled=busy||!canEdit
 for(const b of $('pipeline').querySelectorAll('button'))b.disabled=busy||!canEdit
 $('send-hint').textContent=!open?'เคสนี้ปิดแล้ว':canEdit?'ตรวจข้อความก่อนกดส่ง':'ตอบได้เลย · กด "รับเคส" ก่อนถ้าจะแก้ข้อมูลหรือเลื่อนสถานะ'
 renderLastReply()
}
// "ตอบล่าสุดโดยใคร เมื่อไหร่" — ค่ามาจากฐาน (detail.last_agent_reply) ไม่ได้เดาจากรายการข้อความ
// เพราะรายการโหลดมาแค่ 100 ก้อนล่าสุด เคสที่คุยยาวจะหาคำตอบล่าสุดไม่เจอ
// id เต็มอยู่ในหน้ารายละเอียดเท่านั้น พร้อมปุ่มคัดลอก
// เอาไว้ให้เซลส์เอาไปเทียบกับระบบอื่นได้ โดยไม่ต้องให้มันกินที่บนการ์ดทุกใบ
function renderContactId(externalId){
 const box=$('contact-id');if(!box)return
 const id=(externalId??'').trim()
 box.hidden=!id
 if(!id)return
 box.replaceChildren()
 const v=text('code',id,'contact-id-value');v.title=id
 const b=text('button','คัดลอก');b.type='button';b.className='subtle'
 b.addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(id);b.textContent='คัดลอกแล้ว';setTimeout(()=>b.textContent='คัดลอก',1500)}
  catch{note('คัดลอกไม่สำเร็จ กรุณาเลือกข้อความเอง',true)}
 })
 box.append(text('small','รหัสลูกค้าในแพลตฟอร์ม'),v,b)
}
function renderLastReply(){
 const box=$('last-reply');if(!box)return
 const r=detail&&detail.last_agent_reply
 box.hidden=!r
 if(!r)return
 const mine=r.by===boot?.user?.id
 box.textContent='ตอบล่าสุดโดย '+(mine?'คุณ':(r.name||'ทีมงาน'))+' · '+date(r.at)
}
// ★ ชิปโครงการ (Naii/Vibe) ไม่มี filter ฝั่งฐานรองรับ — ฐานมีแค่สถานะ/เจ้าของ ไม่มีตัวกรองตามโครงการ
//   ขอเพิ่ม RPC ใหม่จะเกินสโคป "แก้ UI เท่านั้น" ของงานนี้ จึงขอ filter='all' จากฐานมาก่อน
//   แล้วกรองเหลือเฉพาะโครงการที่เลือกฝั่งนี้ — พีนัลตี: หน้าเดียว (50 แถว) อาจมีของโครงการอื่นปนมา
//   ถ้าอยากให้ pagination แม่นสมบูรณ์ทุกกรณี ต้องเพิ่มพารามิเตอร์ project ใน connect_api (ไม่ทำในรอบนี้)
async function loadList(){const seq=++listSequence
 const isProject=filter.startsWith('proj-')
 const search=$('search').value.trim()
 // ★ ดาว/tag ไปทาง inbox.flag_list (ไม่แตะ connect_private.api) — แถวรูปเดียวกับ list
 const data=isFlagFilter(filter)?await api('flag_list',flagListArgs(filter,search,offset)):await api('list',{filter:isProject?'all':filter,search,offset})
 if(seq!==listSequence)return
 const projectId=isProject?projectIdFor(PROJECT_CHIPS.find(([k])=>k===filter)?.[2]):null
 const page=isProject?data.filter(x=>x.project_id===projectId):data
 items=page.slice(0,50)
 $('next').disabled=data.length<=50;$('previous').disabled=offset===0
 await loadFlags(items.map(i=>i.id));if(seq!==listSequence)return
 renderList();await refreshCounts()}
// เรียกครั้งเดียวต่อหน้า แล้ว merge ลงการ์ด — อ่านไม่ได้ก็แค่ไม่มีดาว/tag หน้าจอไม่พัง
async function loadFlags(ids){
 // เคสที่เปิดอยู่อาจไม่อยู่ในหน้านี้ (เปิดจากลิงก์/เปลี่ยนตัวกรอง) — ขอรวมไปด้วย หัวแชทจะได้ไม่หาย
 const want=[...new Set(selected?[...ids,selected]:ids)]
 if(!want.length){flags={};return}
 try{flags=await api('case_flags',{conversation_ids:want})}catch{/* คงของเดิมไว้ */}
}
// ชื่อย่อโครงการบนแท็ก — ย้อนจาก project_id ของแถวไปหารหัสโครงการ แล้วเทียบกับชิปที่มีอยู่แล้ว
// ไม่ออกแบบใหม่: ใช้ป้ายเดียวกับที่อยู่บนชิปตัวกรอง (Naii/Vibe) ให้อ่านตรงกันทั้งหน้า
function projectTagLabel(projectId){
 if(!projectId)return ''
 const code=boot?.projects?.find(p=>p.id===projectId)?.code
 return PROJECT_CHIPS.find(([,,c])=>c===code)?.[1] ?? ''
}

// ── การ์ดแชท (ChatRow) ──────────────────────────────────────────────────
// โครง: avatar+badge ช่องทาง │ (ชื่อ+ป้าย SLA ···· เวลา) แถวบน / (ข้อความล่าสุด ···· แท็กโครงการ+ยังไม่อ่าน) แถวล่าง
function renderList(){
  $('conversations').replaceChildren();
  // ★ สเปกเฟส 1: บนจอแคบแต่ละแถวมีแท็กได้ "แท็กเดียว" — แท็ก SLA ย้ายลงไปแทนที่
  //   แท็กโครงการในแถวล่าง ส่วนแท็กเตือนนัดหมายยังอ่านได้จาก title ของแถว (b.title)
  //   ต้องประกาศนอก loop เพราะใช้ตั้งแต่แถวบนของการ์ด ประกาศกลางทางจะติด TDZ
  const oneTag=MOBILE.matches;
  for(const item of items){
    const closed=item.status==='resolved';
    // ★ ป้าย SLA มาจาก slaTag() ตัวเดียว (public/sla.mjs) ไม่ใช่ sla() เดิมที่แยกกันสองระดับ
    //   ตอบแล้ว/ปิดแล้วไม่มีป้าย · รอ 5-9 นาทีแดงอ่อน · 10+ นาทีแดงเข้ม (#8E1116)
    const tag=closed?{label:'',tone:'none'}:slaTag(item.waiting_minutes,item.case_status)
    const overdue=tag.tone==='over'
    const b=text('button','','chat-row'+(item.id===selected?' selected':'')+(overdue?' overdue':''));

    const shown=customerName(item.display_name,item.external_id,item.channel);
    const avatarBox=avatar(item.picture_url,shown);
    // ★ badge ช่องทางอยู่มุมล่างขวาของ avatar ตามสเปก ไม่ใช่ pill แยกในแถวข้อความแบบเดิม
    avatarBox.append(text('span','','channel-badge '+(item.channel==='line'?'line':'fb')));
    b.append(text('div','','chat-row-avatar')); b.lastChild.append(avatarBox);

    const body=text('div','','chat-row-body');

    // แถวบน: ชื่อ + ป้าย SLA/แจ้งเตือน ····· เวลา
    const top=text('div','','chat-row-top');
    const name=text('strong',shown,'chat-row-name');
    if(item.unread_count>0){const dot=text('span','','unread-dot');dot.setAttribute('aria-hidden','true');name.prepend(dot)}
    top.append(name);
    const f=flags[item.id]||{};
    top.append(starToggle(item.id,!!f.starred,'chat-row-star'));
    if(tag.label&&!oneTag){
      const el=text('span',tag.label,'sla-tag '+tag.tone);
      el.title=tag.label;top.append(el)
    }
    const alerts=dueAlerts(item,closed);
    if(alerts.length){
      const short=ALERT_SHORT[alerts[0]]||alerts[0];
      if(!oneTag)top.append(text('span',alerts.length>1?short+' +'+(alerts.length-1):short,'sla-tag over'));
      top.append(text('span',' ('+alerts.join(' · ')+')','sr-only'));
      b.title=alerts.join(' · ')
    }
    const stamp=listTime(item.last_message_at),when=text('span',stamp,'chat-row-time');
    if(stamp)when.title=date(item.last_message_at);
    top.append(when);
    body.append(top);

    // แถวล่าง: ข้อความล่าสุด ····· แท็กโครงการ + ยังไม่อ่าน
    const bottom=text('div','','chat-row-bottom');
    bottom.append(text('p',item.last_message_preview||'ยังไม่มีข้อความ','chat-row-preview'));
    const meta=text('div','','chat-row-meta');
    const proj=projectTagLabel(item.project_id);
    if(oneTag&&tag.label)meta.append(text('span',tag.label,'sla-tag '+tag.tone));
    else if(proj)meta.append(text('span',proj,'project-tag'));
    if(item.unread_count>0)meta.append(text('span',String(Math.min(item.unread_count,99)),'unread-badge'));
    bottom.append(meta);
    body.append(bottom);

    // แถวที่สาม (มีเฉพาะการ์ดที่มี tag/วันติดตาม): tag สูงสุด 2 อัน +N (1 อันถ้ามีวันติดตาม — คอลัมน์แคบ) · ⏰ วันติดตาม (เลยกำหนด = อำพัน ไม่ใช่แดง)
    // ★ แยกแถวเพราะคอลัมน์รายการแคบ — ยัดรวมกับแท็กโครงการแล้วถูกตัดจนอ่านไม่ออก
    const fat=f.follow_up_at??item.follow_up_at,fb=closed?null:followBadge(fat),ct=cardTags(f.tags,fb?1:2);
    if(ct.shown.length||fb){
      b.classList.add('has-flags');
      const row=text('div','','chat-row-flags');
      for(const t of ct.shown)row.append(tagChip(t,'card-tag'));
      if(ct.more)row.append(text('span','+'+ct.more,'card-tag more'));
      if(fb){const el=text('span',fb.label,'follow-badge'+(fb.overdue?' overdue':''));el.title='ติดตาม '+date(fat)+(f.follow_note?' · '+f.follow_note:'');row.append(el)}
      body.append(row);
    }

    b.append(body);
    b.addEventListener('click',()=>selectCase(item.id).catch(e=>note(e.message,true)));$('conversations').append(b)
  }
  if(!items.length)$('conversations').append(text('p','ไม่พบเคสในรายการนี้','muted'))
}
// ชนิดข้อความที่ปกติต้องมีสื่อแนบ — เจอแบบนี้แต่ไม่มี media แปลว่าเป็นของเก่าก่อนท่อรูป (sql/037)
// สื่อของเก่าหายไปตามอายุ URL ของฝั่งผู้ให้บริการ กู้คืนไม่ได้ จึงแสดงป้ายแทนรูปให้ชัด
const MEDIA_TYPES = new Set(['attachment', 'image', 'video', 'audio', 'file'])
const mediaChip = label => text('span', label, 'media-miss')
function renderMessages(messages,prepend=false){
  if(!prepend)$('messages').replaceChildren()
  const fragment=document.createDocumentFragment()
  for(const m of messages){
    const b=text('div','','bubble'+(m.sender_type==='agent'?' out':m.sender_type==='bot'?' bot':''))
    const files=Array.isArray(m.media)?m.media:[]
    if(files.length){
      for(const f of files){
        if(/^image\//.test(f.mime||'')){
          const img=document.createElement('img')
          img.className='media-img';img.loading='lazy';img.alt='[รูปแนบ]'
          img.addEventListener('error',()=>img.replaceWith(mediaChip('[รูปเปิดไม่ได้]')))
          img.src='/media/'+f.path
          b.append(img)
        }else{
          const a=document.createElement('a')
          a.className='media-file';a.href='/media/'+f.path;a.target='_blank';a.rel='noopener'
          a.textContent='[ไฟล์แนบ · '+(f.mime||'ไม่ทราบชนิด')+']'
          b.append(a)
        }
      }
      // คำพูดของลูกค้าที่พิมพ์มากับรูป — ข้อความใน [ ] เป็นป้ายของระบบ ไม่ใช่คำพูด
      if(m.content&&!m.content.startsWith('['))b.append(text('p',m.content,'media-caption'))
    }else if((m.content_type==='image'||/^https:\/\/[^\s]+\/quotation-image\/[0-9a-f-]{36}\?/i.test(m.content||''))&&/^https:\/\//i.test(m.content||'')){
      const img=document.createElement('img');img.className='media-img';img.loading='lazy';img.alt='[รูปที่ส่ง]';img.src=m.content;img.addEventListener('error',()=>img.replaceWith(mediaChip('[รูปเปิดไม่ได้]')));b.append(img)
    }else if(MEDIA_TYPES.has(m.content_type||'')){
      b.append(mediaChip('[รูป/ไฟล์แนบยังไม่พร้อม]'))
    }else{
      b.append(document.createTextNode(m.content))
    }
    const status=m.sender_type==='agent'?({pending:'รอส่ง',processing:'กำลังส่ง',sent:'ส่งสำเร็จ',failed:'ส่งไม่สำเร็จ',uncertain:'ยังยืนยันการส่งไม่ได้'}[m.delivery_status]||'บันทึกแล้ว'):m.sender_type==='bot'?'Bot':''
    b.append(text('small',date(m.created_at)+(status?' · '+status:''),m.delivery_status==='failed'?'delivery-error':''))
    if(m.delivery_status==='failed'){const retry=text('button','ลองส่งอีกครั้ง');retry.addEventListener('click',()=>mutate('retry',{message_id:m.id}));b.append(retry)}
    fragment.append(b)
  }
  if(prepend)$('messages').prepend(fragment);else $('messages').append(fragment)
  $('older').hidden=messages.length<100
}
async function selectCase(id){if(busy)return;if(dirty&&!confirm('มีข้อมูลที่ยังไม่ได้บันทึก ต้องการเปลี่ยนเคสหรือไม่?'))return;if(selected)drafts.set(selected,$('message').value);const seq=++sequence;const data=await api('detail',{id});if(seq!==sequence)return;selected=id;detail=data;items=items.map(item=>item.id===id?{...item,unread_count:0}:item);dirty=false;$('empty').hidden=true;$('chat').hidden=false;setChatOpen(true);$('lead-empty').hidden=true;$('lead-details').hidden=false;renderDetail();renderList();$('messages').scrollTop=$('messages').scrollHeight
 renderCustomerPanel()
 if(!flags[id])api('case_flags',{conversation_ids:[id]}).then(r=>{if(id!==selected)return;flags={...flags,...r};renderHeadFlags();renderFollow()}).catch(()=>{})}
// รูปกับโครงการบนหัวแชท — รูปเอาจากแถวในรายการก่อน (ที่นั่นมี picture_url แน่นอน)
// แล้วค่อยถอยไปหาของใน detail เผื่อเปิดเคสที่ยังไม่อยู่ในรายการหน้านี้
function renderChatHeadExtras(who){
 const box=$('chat-avatar')
 if(box){
  const url=items.find(i=>i.id===selected)?.picture_url||detail.contact?.picture_url||''
  box.replaceChildren()
  box.textContent=initials(who)
  if(url){
   const img=document.createElement('img')
   img.alt='';img.loading='lazy'
   img.addEventListener('error',()=>img.remove())
   img.src=url
   box.append(img)
  }
 }
 const tag=$('chat-project')
 if(!tag)return
 const c=detail.conversation||{}
 const id=c.project_id||detail.lead?.project_id||items.find(i=>i.id===selected)?.project_id||''
 const name=boot?.projects?.find(p=>p.id===id)?.name||projectTagLabel(id)
 tag.textContent=name
 tag.hidden=!name
}
function renderDetail(){const c=detail.conversation,l=detail.lead||{},s=detail.state||{};const who=customerName(detail.contact.display_name,detail.contact.external_id,detail.channel);$('chat-name').textContent=who;renderContactId(detail.contact.external_id);$('chat-channel').textContent=detail.channel==='line'?'LINE':'Messenger';renderChatHeadExtras(who);const wait=sla(detail.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;$('display-name').value=detail.contact.display_name||'';$('phone').value=detail.contact.phone||'';$('budget').value=l.budget??'';$('room').value=l.interest_unit_type||'';$('interest').value=l.extra?.interest||'unknown';$('project').value=l.project_id||boot.projects[0]?.id||'';$('owner').textContent=boot.assignees.find(a=>a.id===c.assignee_id)?.name||'ยังไม่มีคนรับ';$('appointment-summary').textContent=s.appointment_at?date(s.appointment_at):'ยังไม่มีนัดหมาย';renderDue(s,c.status==='resolved');renderFollow();renderHeadFlags();$('message').value=drafts.get(selected)||'';renderMessages(detail.messages);$('pipeline').replaceChildren();for(const [code,label]of Object.entries(stageNames)){if(code==='lost')continue;const b=text('button',label,l.stage_code===code?'active':'');b.addEventListener('click',()=>stage(code));$('pipeline').append(b)}$('canned').replaceChildren();$('canned').hidden=true;permissions()}
async function mutate(action,data={}){if(busy||!selected)return;const id=selected;const key=JSON.stringify({id,action,data});const requestId=pendingCommands.get(key)||crypto.randomUUID();pendingCommands.set(key,requestId);setBusy(true);try{const result=await api(action,{...data,id,request_id:requestId});pendingCommands.delete(key);if(action==='send'){drafts.delete(id);$('message').value=''}$('dialog').close();dirty=false;detail=await api('detail',{id});renderDetail();await loadList();note(action==='send'||action==='send_image'?(action==='send_image'?'รูปเข้าคิวแล้ว สถานะส่งจะแสดงใต้รูป':'ข้อความเข้าคิวแล้ว สถานะส่งจะแสดงใต้ข้อความ'):result.booking_id?'บันทึกเอกสารจองและข้อมูล ERP แล้ว':'บันทึกข้อมูลแล้ว')}catch(e){if(e.code&&e.code!=='service_unavailable')pendingCommands.delete(key);note(e.message,true);$('dialog-error').textContent=e.message}finally{setBusy(false)}}
window.asherSendImage=url=>mutate('send_image',{url})
let dialogAction,dialogData
function dialog(title,fields,action,extra={}){dialogAction=action;dialogData={...extra};delete dialogData.submitLabel;$('dialog-title').textContent=title;$('dialog-submit').textContent=extra.submitLabel||'ยืนยัน';$('dialog-fields').replaceChildren();$('dialog-error').textContent='';for(const f of fields){const label=text('label',f.label);const input=document.createElement(f.options?'select':'input');input.name=f.name;input.required=f.required!==false;if(f.options){for(const o of f.options){const option=text('option',o.label);option.value=o.value;input.append(option)}}else{input.type=f.type||'text';if(f.min!==undefined)input.min=f.min;if(f.step)input.step=f.step;if(f.value!==undefined)input.value=f.value;if(f.maxLength)input.maxLength=f.maxLength}label.append(input);$('dialog-fields').append(label)}$('dialog').showModal()}
function stage(code){if(!detail||code===detail.lead?.stage_code)return;if(code==='appointment')return appointment();if(code==='booking'){if(!detail.units.length){note('ยังไม่มีห้องพร้อมจองใน ERP กรุณาให้ผู้ดูแลเพิ่มห้องก่อน',true);return}dialog('ยืนยันการจองห้อง',[{name:'unit_id',label:'ห้อง',options:detail.units.map(u=>({value:u.id,label:u.number+' · '+Number(u.price).toLocaleString()+' บาท'}))},{name:'amount',label:'ราคาสุทธิ (บาท)',type:'number',min:1,step:'.01'},{name:'deposit',label:'เงินจอง (บาท)',type:'number',min:0,step:'.01'}],'stage',{stage:code});return}if(code==='sale'){dialog('ยืนยันปิดการขาย',[{name:'reference',label:'เลขที่สัญญา / เอกสารอ้างอิง',maxLength:200}],'stage',{stage:code});return}dialog('ยืนยันสถานะ '+stageNames[code],[],'stage',{stage:code})}
function appointment(){dialog('นัดเข้าชม · เวลาไทย',[{name:'appointment_at',label:'วันและเวลานัด',type:'datetime-local',value:local(detail.state?.appointment_at)}],'appointment')}
let botState=[]
// สถานะบอทต้องอ่านจากฐานเสมอ ไม่ใช่จำไว้ในหน้าจอ — ผู้จัดการอีกคนอาจเพิ่งกดปิดไป
async function refreshBot(){
 try{botState=await api('bot_status')}catch{botState=[]}
 renderSendMode()
 const btn=$('bot-toggle');if(!btn)return
 const on=botState.some(b=>b.generate)
 const pending=botState.reduce((n,b)=>n+Number(b.pending_generate||0),0)
 const manager=['manager','admin'].includes(boot?.user?.role)
 btn.hidden=!botState.length
 btn.disabled=!manager
 // งานที่ค้างเพราะปิดบอทไว้ ต้องโชว์ตรงปุ่ม ไม่งั้น "ปิดอยู่" กับ "พัง" แยกกันไม่ออก
 btn.textContent=(on?'บอทเปิด · กดเพื่อปิด':'บอทปิด · กดเพื่อเปิด')+(pending?' (ค้าง '+pending+')':'')
 btn.className='subtle'+(on?' bot-on':'')
 btn.title=manager?(on?'ปิดแล้วจะไม่มีการเรียก AI อีก งานที่ค้างจะรออยู่ในคิว':'เปิดแล้วระบบจะเรียก AI คิดคำตอบทุกข้อความ ซึ่งมีค่าใช้จ่าย'):'เฉพาะผู้จัดการขึ้นไป'
}
// โหมดส่ง: อ่านจากฐานผ่าน bot_status เหมือนสวิตช์บอท ไม่ใช่จำไว้ในหน้าจอ
// ต้องเปิดครบทุกช่องทางถึงจะถือว่า "ส่งจริง" — ให้ตรงกับ bool_and ฝั่งฐาน (sql/016)
// ไม่งั้นหน้าจอจะบอกว่าเปิดแล้ว ทั้งที่ตัวส่งยังไม่เดิน
function renderSendMode(){
 const btn=$('send-toggle');if(!btn)return
 const on=botState.length>0&&botState.every(b=>b.live)
 const admin=boot?.user?.role==='admin'
 btn.hidden=!botState.length
 btn.disabled=!admin
 btn.textContent=on?'ส่งจริง · กดเพื่อหยุดส่ง':'โหมดเก็บข้อมูล · กดเพื่อเปิดส่งจริง'
 btn.className='subtle'+(on?' send-live':'')
 btn.title=admin?(on?'ข้อความที่เซลส์กดส่งจะถึงลูกค้าจริง กดเพื่อกลับไปเก็บข้อมูลอย่างเดียว':'ตอนนี้รับเข้าอย่างเดียว ยังไม่มีอะไรออกไปหาลูกค้า'):'เฉพาะ admin'
}
$('send-toggle').addEventListener('click',async()=>{
 const next=!(botState.length>0&&botState.every(b=>b.live))
 if(next&&!confirm('เปิดส่งจริงแล้ว ข้อความที่เซลส์กดส่งจะถึงลูกค้าตัวจริงทันที รวมทั้งงานที่ค้างอยู่ในคิวขาออก\n\nยืนยันเปิดหรือไม่?'))return
 const btn=$('send-toggle');btn.disabled=true
 try{
  await api('send_switch',{enabled:next})
  await refreshBot();note(next?'เปิดส่งจริงแล้ว ข้อความจะถึงลูกค้า':'กลับไปโหมดเก็บข้อมูลแล้ว ไม่มีอะไรออกไปหาลูกค้า')
 }catch(e){note(e.message,true);btn.disabled=false}
})
$('bot-toggle').addEventListener('click',async()=>{
 const next=!botState.some(b=>b.generate)
 if(next&&!confirm('เปิดบอทแล้วระบบจะเรียก AI คิดคำตอบทุกข้อความที่ลูกค้าทักเข้ามา ซึ่งมีค่าใช้จ่ายจริงต่อข้อความ\n\nยืนยันเปิดหรือไม่?'))return
 const btn=$('bot-toggle');btn.disabled=true
 try{
  await api('bot_switch',{switch:'generate',enabled:next})
  await api('bot_switch',{switch:'classify',enabled:next})
  await refreshBot();note(next?'เปิดบอทแล้ว ระบบจะเริ่มคิดคำตอบให้ลูกค้า':'ปิดบอทแล้ว ไม่มีการเรียก AI อีก')
 }catch(e){note(e.message,true);btn.disabled=false}
})
$('reply').addEventListener('submit',e=>{e.preventDefault();const value=$('message').value.trim();if(value)mutate('send',{text:value})})
$('composer-menu-toggle').addEventListener('click',()=>{const menu=$('composer-actions'),open=menu.hidden;menu.hidden=!open;$('composer-menu-toggle').setAttribute('aria-expanded',String(open));$('composer-menu-toggle').setAttribute('aria-label',open?'ปิดเมนูตอบลูกค้า':'เปิดเมนูตอบลูกค้า')})
$('composer-actions').addEventListener('click',e=>{if(!e.target.closest('.composer-action'))return;$('composer-actions').hidden=true;$('composer-menu-toggle').setAttribute('aria-expanded','false');$('composer-menu-toggle').setAttribute('aria-label','เปิดเมนูตอบลูกค้า')})
$('attach').addEventListener('click',()=>$('outbound-image-input').click())
$('outbound-image-input').addEventListener('change',async()=>{const input=$('outbound-image-input'),file=input.files?.[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size||file.size>10*1024*1024){note('รองรับ PNG, JPEG หรือ WebP ขนาดไม่เกิน 10 MB',true);input.value='';return}const button=$('attach');button.disabled=true;note('กำลังอัปโหลดรูป…');try{const response=await fetch('/api/outbound-image',{method:'POST',headers:{'Content-Type':file.type,'X-Filename':encodeURIComponent(file.name)},body:file});const data=await response.json();if(!response.ok)throw new Error(errors[data.error]||'อัปโหลดรูปไม่สำเร็จ');await window.asherSendImage(data.public_url)}catch(e){note(e.message,true)}finally{button.disabled=false;input.value=''}})
$('quote-png').addEventListener('click',()=>window.asherExportAvailableUnitsPng?.())
$('lead-form').addEventListener('input',()=>dirty=true)
$('lead-form').addEventListener('submit',e=>{e.preventDefault();mutate('save',{version:detail.state.version,display_name:$('display-name').value,phone:$('phone').value,project_id:$('project').value,budget:$('budget').value,room:$('room').value,interest:$('interest').value,
 // ★ วันติดตามย้ายไปบันทึกผ่าน case_follow แล้ว แต่ save บน VPS ยัง nullif(follow_up_at) — ไม่ส่ง = ล้างค่า
 //   จึงส่งค่าปัจจุบันกลับไปเสมอจนกว่า save จะเลิกแตะคอลัมน์นี้
 follow_up_at:detail.state?.follow_up_at||''})})
$('claim').addEventListener('click',()=>mutate('claim'))
$('transfer').addEventListener('click',()=>dialog('โอนเคส',[{name:'assignee_id',label:'ผู้รับผิดชอบใหม่',options:boot.assignees.map(a=>({value:a.id,label:a.name}))}],'transfer'))
$('appointment').addEventListener('click',appointment)
$('close').addEventListener('click',()=>dialog('ปิดเคส / เสีย Lead',[{name:'reason',label:'เหตุผลที่ปิดเคส',maxLength:2000}],'close'))
$('cancel').addEventListener('click',()=>$('dialog').close())
$('dialog-form').addEventListener('submit',e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));if(dialogAction==='quotation_png')return generateUnitQuotation(values.unit_id);if(values.appointment_at)values.appointment_at=utc(values.appointment_at);mutate(dialogAction,{...dialogData,...values})})
$('refresh').addEventListener('click',()=>loadList().catch(e=>note(e.message,true)))
$('previous').addEventListener('click',()=>{offset=Math.max(0,offset-50);loadList().catch(e=>note(e.message,true))})
$('next').addEventListener('click',()=>{offset+=50;loadList().catch(e=>note(e.message,true))})
let searchTimer;$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;loadList().catch(e=>note(e.message,true))},350)})
$('older').addEventListener('click',async()=>{const id=selected;try{const first=detail.messages[0];if(!first)return;const data=await api('messages',{id,before:first.created_at});if(id!==selected)return;detail.messages=[...data.messages,...detail.messages];renderMessages(data.messages,true)}catch(e){note(e.message,true)}})
// ชื่อช่องทางเต็ม ๆ ยาวเกินกว่าจะวางบนแถบหัวได้ ย่อเหลือคำที่คนในทีมเรียกกันจริง
// ★ จับจากคำในชื่อ ไม่ผูกกับลำดับในไฟล์ channels.json เพราะลำดับนั้นเปลี่ยนได้
// ชื่อเต็มไม่หายไปไหน อยู่ใน title ให้ hover ดู
// ชื่อบนชิปมาจาก channels.json ที่เดียว
// ของเดิมเดาชื่อจาก regex ที่นี่ (เจอ /condo/ ก็ขึ้น "Asher Condo")
// ทำให้เปลี่ยนชื่อใน channels.json แล้วหน้าจอไม่ขยับ — หาสาเหตุยาก
function shortChannel(c){ return c.name||c.key||'' }
// ───────────────────────────────────────── ชิปตัวกรองกล่องข้อความ
//
// ★ ชื่อย่อใช้บนชิป ชื่อเต็มอยู่ใน title/aria-label เสมอ
//   แถบนี้กว้างจำกัด ถ้าใช้ชื่อเต็มจะขึ้นบรรทัดใหม่หรือถูกตัด แล้วอ่านไม่รู้เรื่องทั้งคู่
const shortLabels={all:'ทั้งหมด',unassigned:'ยังไม่ตอบ'}
// ★ ชิปตัวกรองของหน้านี้เหลือ 4 อันแบบเรียบ (ทั้งหมด/ยังไม่ตอบ + โครงการ) ตามสเปกใหม่
//   ของเดิมมีถึง 8 ตัวกรอง (mine/unassigned/waiting/sla/today/followup/closed/all) และมีเมนู "เพิ่มเติม"
//   ไม่ได้ลบตัวกรองพวกนั้นออกจากฐาน แค่หน้าจอนี้เลือกแสดงแค่ที่สเปกขอ
//
// ★ "ยังไม่ตอบ" แม็ปกับ filter เดิมชื่อ 'unassigned' (ยังไม่มีคนรับ) ไม่ใช่ case_status
//   เหตุผล: มันคือคีย์เดียวที่ inbox.queue_counts() มีตัวเลขให้แล้ว และในระบบคิวรวม
//   (shared queue ไม่มีเจ้าของเคส) เคสที่ยังไม่มีคนรับกับเคสที่ยังไม่ถูกตอบเป็นเซตที่ทับกันเกือบสนิท
//   ถ้าจะให้ตรงกับ case_status='new'|'late' เป๊ะ ต้องเพิ่มตัวนับใหม่ฝั่งฐาน — ยังไม่ทำในรอบนี้
const STATUS_CHIPS=['all','unassigned']
// รหัสโครงการจริงจาก core.project.code — เทียบจาก boot.projects ตอน render ไม่ฮาร์ดโค้ด id
const PROJECT_CHIPS=[['proj-naii','Naii','asher-naii'],['proj-vibe','Vibe','asher-vibe']]

const urlNames={all:'all',unassigned:'pending','proj-naii':'naii','proj-vibe':'vibe',starred:'starred',followup:'followup'}
const fromUrl=Object.fromEntries(Object.entries(urlNames).map(([k,v])=>[v,k]))
const readFilter=()=>{const v=new URL(location.href).searchParams.get('filter')||''
 if(/^tag-[0-9a-f-]{36}$/.test(v))return 'tag:'+v.slice(4)
 return fromUrl[v]||'all'}
function writeFilter(){const u=new URL(location.href)
 u.searchParams.set('filter',filter.startsWith('tag:')?'tag-'+filter.slice(4):urlNames[filter]||'all')
 history.replaceState(null,'',u)}
let counts={}

// กดชิปที่เลือกอยู่ซ้ำ = ถอดตัวกรอง กลับไปทั้งหมด
function pickFilter(key){const next=filter===key?'all':key
 if(filter===next&&key!=='all')return
 filter=next;offset=0;writeFilter();renderFilters();loadList().catch(e=>note(e.message,true))}

function projectIdFor(code){return boot?.projects?.find(p=>p.code===code)?.id ?? null}

// ★ สีแดงใช้เฉพาะตอนมีของค้างจริง (count>0) บนชิป "ยังไม่ตอบ" เท่านั้น — ชิปอื่นไม่มีวันเป็นสีแดง
function chipFor(key,label,n){
 const on=filter===key
 const b=text('button','','chip'+(on?' selected':'')+(n>0&&key==='unassigned'?' hot-alert':''))
 b.type='button';b.title=label
 b.setAttribute('aria-pressed',String(on))
 b.setAttribute('aria-label',label+(n>0?' '+n+' เคส':''))
 if(key==='unassigned'&&n>0){const d=text('span','','chip-dot');d.setAttribute('aria-hidden','true');b.append(d)}
 b.append(text('span',label,'chip-name'))
 if(n>0)b.append(text('span',String(n),'chip-n'))
 b.addEventListener('click',()=>pickFilter(key))
 return b
}

function renderFilters(){
 const nav=$('filters');if(!nav)return
 nav.replaceChildren()
 for(const key of STATUS_CHIPS)nav.append(chipFor(key,shortLabels[key],counts[key]??0))
 for(const [key,label]of PROJECT_CHIPS)nav.append(chipFor(key,label,0))
 // ★ ดาว/ติดตาม/Tag — ตัวเลขดาว+tag มาจาก tags_list, ติดตามมาจาก queue_counts (ตัวกรอง followup เดิม)
 nav.append(chipFor('starred','★ ติดดาว',tagState.starred??0))
 nav.append(chipFor('followup','⏰ ถึงเวลาติดตาม',counts.followup??0))
 nav.append(tagFilterChip())
}

// นับทุกตัวกรองในคำขอเดียว แล้ววาดชิปใหม่
// นับไม่ได้ไม่ใช่เหตุให้หน้าจอพัง — ชิปยังกดได้ แค่ไม่มีตัวเลข
async function refreshCounts(){
 try{counts=await api('queue_counts',{search:$('search').value.trim()})}
 catch{counts={}}
 await refreshTags()
 renderFilters()
 renderUnreadBadge()
}

// ตัวเลขบนไอคอนแชท — ใช้ตัวเดียวกับชิป "ยังไม่ตอบ" จะได้ไม่มีวันขัดกันเอง
function renderUnreadBadge(){
 const badge=$('nav-unread');if(!badge)return
 const n=Number(counts.unassigned)||0
 badge.textContent=n>99?'99+':String(n)
 badge.hidden=n===0
}

// ───────────────────────────────────────── ติดดาว · ติดตาม · Tag
// spec: docs/handoff/2026-10-01-star-follow-tags.md · ด่านสิทธิ์อยู่ที่ inbox.* ในฐาน
// ★ ดาว/tag ผูกกับ "ลูกค้า" ไม่ใช่เคส — ลูกค้าคนเดียวที่ทักหลายช่องทางเห็นชุดเดียวกัน
//   แก้แล้วจึงต้องโหลด flags ของทั้งหน้าใหม่ ไม่ใช่แก้แค่การ์ดใบที่กด
async function refreshTags(){
 try{tagState=await api('tags_list',{})}catch{/* ใช้ของเดิม ชิปยังกดได้ */}
}
async function reloadFlags(){await loadFlags(items.map(i=>i.id));renderList();renderHeadFlags()}
const tagChip=(t,cls='tag-chip')=>{const el=text('span',t.name,cls+' tag-'+tagColor(t.color));el.title=t.name;return el}

// ☆/★ — คลิกแล้วไม่เปิดแชท, เปลี่ยนทันที (optimistic) แล้วถอยกลับถ้าฐานปฏิเสธ
// ★ การ์ดเป็น <button> อยู่แล้ว ตัวนี้จึงเป็น span role=button (ปุ่มซ้อนปุ่มไม่ได้)
const STAR_PATH='M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z'
function starIcon(){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg')
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.setAttribute('class','star-icon')
 const p=document.createElementNS('http://www.w3.org/2000/svg','path')
 p.setAttribute('d',STAR_PATH);p.setAttribute('stroke-width','1.8');p.setAttribute('stroke-linejoin','round')
 svg.append(p);return svg
}
function starToggle(id,on,cls){
 const head=cls==='chat-head-star'
 // ★ ไอคอน SVG ขนาดเท่า Facebook (20px การ์ด · 24px หัวแชท) — ตัวอักษร ☆ เดิมเล็กและบางจนมองไม่เห็น
 const el=document.createElement(head?'button':'span');el.className=cls+(on?' on':'')
 el.append(starIcon())
 if(head)el.type='button';else{el.setAttribute('role','button');el.tabIndex=0}
 el.setAttribute('aria-pressed',String(on));el.setAttribute('aria-label',on?'ถอดดาว':'ติดดาว');el.title=on?'ถอดดาว':'ติดดาวลูกค้า potential'
 const act=e=>{e.preventDefault();e.stopPropagation();toggleStar(id)}
 el.addEventListener('click',act)
 el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')act(e)})
 return el
}
async function toggleStar(id){
 const before=flags[id]||{},next=!before.starred
 flags={...flags,[id]:{...before,starred:next}};renderList();renderHeadFlags()
 try{await api('case_star',{conversation_id:id,starred:next});await reloadFlags();await refreshTags();renderFilters();if(id===selected)renderCustomerPanel()}
 catch(e){flags={...flags,[id]:before};renderList();renderHeadFlags();note(e.message,true)}
}

// หัวแชท: ปุ่มดาว + แถว tag + ปุ่ม ＋ Tag
function renderHeadFlags(){
 if(!detail||!selected)return
 const host=document.querySelector('.chat-head-text');if(!host)return
 let row=$('chat-flags')
 if(!row){row=text('div','','chat-flags');row.id='chat-flags';host.append(row)}
 const f=flags[selected]||{}
 const star=starToggle(selected,!!f.starred,'chat-head-star');star.id='chat-star'
 const add=text('button','＋ Tag','tag-add');add.type='button';add.id='tag-add'
 add.setAttribute('aria-haspopup','true');add.addEventListener('click',()=>openTagPicker(add))
 row.replaceChildren(star,...(f.tags||[]).map(t=>tagChip(t)),add)
}

// popover แบบ LINE: ค้นหา · ติ๊กหลายอัน · "สร้าง tag ใหม่ '…'" ถ้าพิมพ์แล้วไม่เจอ
// opts: ใช้จาก drawer ลูกค้า/หน้ารายชื่อติดต่อได้ — ระบุเคสและแท็กปัจจุบันเอง ไม่ผูกกับเคสที่เปิดอยู่
function openTagPicker(anchor,opts={}){
 $('tag-picker')?.remove()
 const id=opts.id||selected,before=opts.current||(flags[id]?.tags||[]).map(t=>t.id)
 const chosen=new Set(before)
 const box=text('div','','tag-picker');box.id='tag-picker';box.setAttribute('role','dialog');box.setAttribute('aria-label','เลือก Tag')
 const q=document.createElement('input');q.type='search';q.placeholder='ค้นหาหรือพิมพ์ชื่อ tag ใหม่';q.maxLength=30;q.setAttribute('aria-label','ค้นหา tag')
 const list=text('div','','tag-picker-list')
 const done=text('button','บันทึก','primary');done.type='button'
 const cancel=text('button','ยกเลิก','subtle');cancel.type='button'
 const close=()=>{box.remove();document.removeEventListener('mousedown',outside,true)}
 const outside=e=>{if(!box.contains(e.target)&&e.target!==anchor)close()}
 function draw(){
  const m=matchTags(tagState.tags,q.value)
  list.replaceChildren()
  for(const t of m.hits){
   const l=text('label','','tag-option');const c=document.createElement('input');c.type='checkbox';c.checked=chosen.has(t.id)
   c.addEventListener('change',()=>{c.checked?chosen.add(t.id):chosen.delete(t.id)})
   l.append(c,tagChip(t));list.append(l)
  }
  if(m.create&&tagState.can_create){
   const b=text('button','＋ สร้าง tag ใหม่ “'+m.create+'”','tag-create');b.type='button'
   b.addEventListener('click',async()=>{
    b.disabled=true
    try{const t=await api('tag_upsert',{name:m.create});await refreshTags();chosen.add(t.id);q.value='';draw()}
    catch(e){note(e.message,true);b.disabled=false}
   })
   list.append(b)
  }
  if(!list.childElementCount)list.append(text('p','ไม่มี tag','muted'))
 }
 q.addEventListener('input',draw)
 done.addEventListener('click',async()=>{
  const diff=tagDiff(before,[...chosen])
  close()
  if(!diff.add.length&&!diff.remove.length)return
  try{await api('case_tags_set',{conversation_id:id,...diff});if(opts.onSaved)await opts.onSaved();else{await reloadFlags();await refreshTags();renderFilters();if(selected)renderCustomerPanel()}}
  catch(e){note(e.message,true)}
 })
 cancel.addEventListener('click',close)
 const foot=text('div','','tag-picker-foot');foot.append(cancel,done)
 box.append(q,list,foot);draw()
 anchor.after(box);q.focus()
 setTimeout(()=>document.addEventListener('mousedown',outside,true))
 box.addEventListener('keydown',e=>{if(e.key==='Escape'){close();anchor.focus()}})
}

// ชิป "Tag ▾" ในแถวตัวกรอง — เลือก tag แล้วรายการไปทาง flag_list
function tagFilterChip(){
 const on=filter.startsWith('tag:')
 const cur=on?tagState.tags.find(t=>'tag:'+t.id===filter):null
 const wrap=text('span','','tag-filter')
 const b=text('button','','chip'+(on?' selected':''));b.type='button'
 b.setAttribute('aria-haspopup','true');b.setAttribute('aria-expanded','false')
 b.append(text('span',cur?'# '+cur.name:'Tag ▾','chip-name'))
 b.title='กรองตาม Tag'
 b.addEventListener('click',e=>{
  e.stopPropagation()
  const open=$('tag-filter-menu');if(open){open.remove();b.setAttribute('aria-expanded','false');return}
  // ★ วางเมนูไว้ที่ body แบบ fixed — #filters เป็นตัวเลื่อนแนวนอน (overflow) เมนูข้างในจะถูกตัดหาย
  const menu=text('div','','chip-menu tag-filter-menu');menu.id='tag-filter-menu';menu.setAttribute('role','menu')
  const r=b.getBoundingClientRect()
  menu.style.top=(r.bottom+4)+'px';menu.style.left=Math.max(16,Math.min(r.left,innerWidth-16-220))+'px'
  for(const t of tagState.tags){
   const it=text('button','','chip-menu-item'+(filter==='tag:'+t.id?' selected':''));it.type='button';it.setAttribute('role','menuitem')
   it.append(tagChip(t),text('span',String(t.count??0),'chip-n'))
   it.addEventListener('click',()=>{menu.remove();pickFilter('tag:'+t.id)})
   menu.append(it)
  }
  if(!tagState.tags.length)menu.append(text('p','ยังไม่มี tag','muted'))
  if(tagState.can_manage||tagState.can_create){
   const m=text('button','จัดการแท็ก…','chip-menu-item');m.type='button'
   m.addEventListener('click',()=>{menu.remove();openTagAdmin()})
   menu.append(m)
  }
  document.body.append(menu);b.setAttribute('aria-expanded','true')
  setTimeout(()=>document.addEventListener('click',()=>{menu.remove();b.setAttribute('aria-expanded','false')},{once:true}))
 })
 wrap.append(b)
 return wrap
}

// หน้าจัดการแท็ก แบบ LINE OA Manager (ตั้งค่า → แท็ก)
// รายการ: ค้นหา · ชิปสี · จำนวนแชท · แก้ไข/ลบ  |  ฟอร์ม: ชื่อ (นับ 0/30) · สี 7 สี · ตัวอย่างสด · ลำดับ
// ★ สิทธิ์ตามฐาน (inbox.tag_upsert / tag_archive): ทุกคนสร้างได้ · แก้/ลบ/เรียงลำดับเฉพาะ manager/admin
//   การซ่อนปุ่มตรงนี้เป็นแค่หน้าตา ด่านจริงอยู่ในฐาน
function openTagAdmin(){
 let dlg=$('tag-admin')
 if(!dlg){dlg=document.createElement('dialog');dlg.id='tag-admin';dlg.className='tag-admin';dlg.setAttribute('aria-labelledby','tag-admin-title');document.body.append(dlg)}
 let query=''
 const manage=()=>tagState.can_manage,create=()=>tagState.can_create
 const after=async()=>{await refreshTags();await reloadFlags();renderFilters()}
 const head=(title,back)=>{
  const h=text('div','','tag-admin-head')
  if(back){const b=text('button','←','icon-btn tag-admin-back');b.type='button';b.setAttribute('aria-label','กลับไปรายการแท็ก');b.addEventListener('click',back);h.append(b)}
  const t=text('h2',title);t.id='tag-admin-title';h.append(t)
  const x=text('button','×','icon-btn tag-admin-close');x.type='button';x.setAttribute('aria-label','ปิด');x.addEventListener('click',()=>dlg.close());h.append(x)
  return h
 }
 function list(){
  const tools=text('div','','tag-admin-tools')
  const q=document.createElement('input');q.type='search';q.placeholder='ค้นหาแท็ก';q.value=query;q.setAttribute('aria-label','ค้นหาแท็ก')
  tools.append(q)
  if(create()){const add=text('button','＋ สร้างแท็ก','primary');add.type='button';add.addEventListener('click',()=>form(null));tools.append(add)}
  const sub=text('p','','tag-admin-sub muted')
  const table=text('div','','tag-admin-table');table.setAttribute('role','table');table.setAttribute('aria-label','รายการแท็ก')
  const drawRows=()=>{
   const rows=matchTags(tagState.tags,query).hits
   sub.textContent='ทั้งหมด '+tagState.tags.length+' แท็ก'+(query?' · พบ '+rows.length:'')+' · แท็กใช้ร่วมกันทั้งทีม ติดได้หลายแท็กต่อลูกค้า'
   const hr=text('div','','tag-admin-tr tag-admin-th');hr.setAttribute('role','row')
   for(const c of ['แท็ก','จำนวนแชท','']){const h=text('span',c);h.setAttribute('role','columnheader');hr.append(h)}
   table.replaceChildren(hr)
   for(const t of rows){
    const r=text('div','','tag-admin-tr');r.setAttribute('role','row')
    const name=text('span','','tag-admin-name');name.setAttribute('role','cell');name.append(tagChip(t))
    const n=text('span',String(t.count??0),'tag-admin-count');n.setAttribute('role','cell');n.title='แชทที่ยังไม่ปิดซึ่งติดแท็กนี้'
    const act=text('span','','tag-admin-actions');act.setAttribute('role','cell')
    if(manage()){
     const e=text('button','แก้ไข','subtle');e.type='button';e.setAttribute('aria-label','แก้ไขแท็ก '+t.name);e.addEventListener('click',()=>form(t))
     const d=text('button','ลบ','subtle danger');d.type='button';d.setAttribute('aria-label','ลบแท็ก '+t.name)
     d.addEventListener('click',async()=>{
      const used=t.count?' แท็กนี้จะหายจากแชท '+t.count+' รายการ':''
      if(!confirm('ลบแท็ก “'+t.name+'”?'+used))return
      d.disabled=true
      try{await api('tag_archive',{id:t.id});if(filter==='tag:'+t.id)pickFilter('all');await after();note('ลบแท็ก “'+t.name+'” แล้ว');drawRows()}
      catch(err){note(err.message,true);d.disabled=false}
     })
     act.append(e,d)
    }
    r.append(name,n,act);table.append(r)
   }
   if(!rows.length)table.append(text('p',query?'ไม่พบแท็ก “'+query+'”':'ยังไม่มีแท็ก','muted tag-admin-empty'))
  }
  q.addEventListener('input',()=>{query=q.value;drawRows()})
  drawRows()
  dlg.replaceChildren(head('จัดการแท็ก'),tools,sub,table)
  q.focus()
 }
 function form(t){
  const editing=!!t
  const f=document.createElement('form');f.className='tag-admin-form';f.noValidate=true
  const nameLabel=text('label','ชื่อแท็ก')
  const nameRow=text('div','','tag-admin-name-row')
  const name=document.createElement('input');name.maxLength=30;name.required=true;name.value=t?.name||'';name.placeholder='เช่น สนใจ 1BR'
  const counter=text('span','','tag-admin-counter muted')
  nameRow.append(name,counter);nameLabel.append(nameRow)
  const colorBox=text('fieldset','','tag-admin-colors');colorBox.append(text('legend','สี'))
  let color=tagColor(t?.color)
  const preview=text('div','','tag-admin-preview')
  const drawPreview=()=>{counter.textContent=name.value.trim().length+'/30';preview.replaceChildren(text('span','ตัวอย่าง','muted'),tagChip({name:name.value.trim()||'ชื่อแท็ก',color}))}
  for(const c of TAG_COLORS){
   const l=text('label','','tag-swatch tag-'+c);l.title=TAG_COLOR_NAMES[c]
   const r=document.createElement('input');r.type='radio';r.name='tag-color';r.value=c;r.checked=c===color;r.setAttribute('aria-label',TAG_COLOR_NAMES[c])
   r.addEventListener('change',()=>{color=c;drawPreview()})
   l.append(r);colorBox.append(l)
  }
  const fields=[nameLabel,colorBox]
  let sort=null
  if(manage()){
   const sl=text('label','ลำดับ (น้อยขึ้นก่อน)');sort=document.createElement('input');sort.type='number';sort.className='tag-sort';sort.value=t?.sort_order??''
   sl.append(sort);fields.push(sl)
  }
  const err=text('p','','tag-admin-error');err.setAttribute('role','alert')
  const cancel=text('button','ยกเลิก','subtle');cancel.type='button';cancel.addEventListener('click',list)
  const save=text('button',editing?'บันทึก':'สร้าง','primary');save.type='submit'
  const foot=text('div','','tag-admin-foot');foot.append(cancel,save)
  name.addEventListener('input',drawPreview)
  f.addEventListener('submit',async e=>{
   e.preventDefault();err.textContent=''
   const v=name.value.trim()
   if(!v){err.textContent='กรุณาใส่ชื่อแท็ก';name.focus();return}
   const dup=tagState.tags.find(x=>x.name.trim().toLowerCase()===v.toLowerCase()&&x.id!==t?.id)
   if(dup&&editing){err.textContent='มีแท็กชื่อนี้อยู่แล้ว';name.focus();return}
   save.disabled=true
   try{
    const r=await api('tag_upsert',{id:t?.id||'',name:v,color,sort_order:sort?sort.value:''})
    await after();note(editing?'บันทึกแท็กแล้ว':r.created===false?'มีแท็ก “'+v+'” อยู่แล้ว':'สร้างแท็ก “'+v+'” แล้ว');list()
   }catch(x){err.textContent=x.code==='tag_exists'?'มีแท็กชื่อนี้อยู่แล้ว':x.message;save.disabled=false}
  })
  f.append(...fields,preview,err,foot)
  drawPreview()
  dlg.replaceChildren(head(editing?'แก้ไขแท็ก':'สร้างแท็ก',list),f)
  name.focus()
 }
 list();if(!dlg.open)dlg.showModal()
}

// lead card: บล็อก "การติดตาม" — ปุ่มลัด + กำหนดเอง + โน้ต + เสร็จแล้ว · บันทึกผ่าน case_follow
// ★ ไม่ต้องรับเคสก่อน (ต่างจากฟอร์มข้อมูลลูกค้า) ด่านคือ can_read ในฐาน
function renderFollow(){
 const box=$('follow-block');if(!box||!detail)return
 const c=detail.conversation,s=detail.state||{},f=flags[selected]||{}
 const open=c.status!=='resolved'
 const at=s.follow_up_at||null
 box.replaceChildren()
 const head=text('div','','follow-head');head.append(text('h3','การติดตาม'))
 const fb=followBadge(at)
 head.append(text('span',at?date(at):'ยังไม่ได้ตั้ง','follow-when'+(fb?.overdue?' overdue':'')))
 box.append(head)
 const presets=text('div','','follow-presets')
 const custom=document.createElement('input');custom.type='datetime-local';custom.value=local(at);custom.setAttribute('aria-label','วันเวลาติดตาม (เวลาไทย)')
 const noteBox=document.createElement('textarea');noteBox.rows=2;noteBox.maxLength=500;noteBox.placeholder='โน้ตสั้น ๆ เช่น โทรหลังเลิกงาน';noteBox.value=f.follow_note||'';noteBox.setAttribute('aria-label','โน้ตการติดตาม')
 const save=text('button','บันทึกการติดตาม','full');save.type='button'
 const doneBtn=text('button','✓ เสร็จแล้ว','subtle full');doneBtn.type='button';doneBtn.hidden=!at
 for(const p of followPresets()){
  const b=text('button',p.label,'follow-preset');b.type='button'
  b.addEventListener('click',()=>{custom.value=local(p.at)})
  presets.append(b)
 }
 const submit=async(when,noteValue)=>{
  for(const el of [save,doneBtn])el.disabled=true
  try{
   const r=await api('case_follow',{conversation_id:selected,follow_up_at:when||'',note:noteValue,version:detail.state?.version})
   // ★ เก็บ version ใหม่ ไม่งั้นกด "บันทึกข้อมูล" ต่อจะชน version_conflict
   detail.state={...(detail.state||{}),follow_up_at:r.follow_up_at,version:r.version}
   flags={...flags,[selected]:{...(flags[selected]||{}),follow_up_at:r.follow_up_at,follow_note:r.follow_note}}
   renderDue(detail.state,detail.conversation.status==='resolved');renderFollow();renderList();await refreshCounts()
   note(when?'ตั้งการติดตามแล้ว':'ปิดการติดตามแล้ว')
  }catch(e){note(e.message,true);for(const el of [save,doneBtn])el.disabled=false}
 }
 save.addEventListener('click',()=>submit(utc(custom.value),noteBox.value))
 doneBtn.addEventListener('click',()=>submit('', ''))
 for(const el of [custom,noteBox,save,doneBtn,...presets.children])el.disabled=!open
 const when=text('label','กำหนดเอง · เวลาไทย');when.append(custom)
 const noteLabel=text('label','โน้ต');noteLabel.append(noteBox)
 box.append(presets,when,noteLabel,save,doneBtn)
}

// ───────────────────────────────────────── drawer ลูกค้า (แบบ LINE OA Manager)
// ใช้ตัวเดียวกันสองที่: แผงขวาในหน้าแชท และ drawer ของหน้ารายชื่อติดต่อ
// ข้อมูลมาจาก inbox.contact_detail (sql/202610021000) ทั้งหมด — ระยะ/SLA/เบอร์ mask คิดที่ฐาน
const CHANNEL_NAME=Object.fromEntries(CHANNELS)
const channelBadge=ch=>{const b=text('span',CHANNEL_NAME[ch]||ch||'?','channel-pill ch-'+(ch||'unknown'));b.title=CHANNEL_NAME[ch]||ch||'';return b}
const stagePill=code=>{const s=stageOf(code);return s?Object.assign(text('span',s[1],'tag-chip stage-pill tag-'+s[2]),{title:s[3]}):text('span','—','muted')}
const slaPill=(sla,w)=>{const s=slaBadge(sla,w);const el=text('span',s.label,'sla-pill '+s.tone);el.title=s.title;return el}
function customerDrawer(d,{mode='chat',currentId=null,onChanged=()=>{}}={}){
 const box=text('div','','cust-drawer')
 const convs=d.conversations||[]
 const latest=convs.find(c=>c.id===currentId)||convs[0]||{}
 const name=customerName(d.display_name,'',latest.channel)
 // หัว: รูป + ชื่อ + ช่องทาง + ดาว
 const head=text('div','','cust-head')
 head.append(avatar(boot?.user?.test_only?'':d.picture_url,name))
 const who=text('div','','cust-who');who.append(text('strong',name,'cust-name'))
 const chs=text('div','','cust-channels');for(const ch of [...new Set(convs.map(c=>c.channel))])chs.append(channelBadge(ch));who.append(chs)
 const star=document.createElement('button');star.type='button';star.className='chat-head-star'+(d.starred?' on':'');star.append(starIcon())
 star.setAttribute('aria-pressed',String(!!d.starred));star.setAttribute('aria-label',d.starred?'ถอดดาว':'ติดดาว');star.title=star.getAttribute('aria-label')
 star.addEventListener('click',async()=>{star.disabled=true;try{await api('case_star',{conversation_id:latest.id,starred:!d.starred});await onChanged()}catch(e){note(e.message,true);star.disabled=false}})
 head.append(who,star);box.append(head)
 // สรุป: ระยะ · SLA · ผู้รับผิดชอบ · เบอร์ · ติดตาม
 const facts=text('dl','','cust-facts')
 const fact=(k,v)=>{facts.append(text('dt',k));const dd=document.createElement('dd');typeof v==='string'?dd.textContent=v:dd.append(v);facts.append(dd)}
 fact('ระยะ',stagePill(latest.stage))
 fact('SLA',slaPill(latest.sla,latest.waiting_minutes))
 fact('ผู้รับผิดชอบ',latest.assignee_name||'ยังไม่มีคนรับ')
 const phone=text('span',d.phone||'—');if(d.phone&&d.phone_masked)phone.title='แสดงบางส่วน — เห็นเต็มเฉพาะ manager/admin'
 fact('เบอร์',phone)
 if(latest.follow_up_at)fact('ติดตาม',date(latest.follow_up_at)+(d.follow_note?' · '+d.follow_note:''))
 box.append(facts)
 // แท็ก
 const tagSec=text('section','','cust-sec');tagSec.append(text('h3','แท็ก'))
 const tagRow=text('div','','chat-flags cust-tags')
 for(const t of d.tags||[])tagRow.append(tagChip(t))
 const add=text('button','＋ แท็ก','tag-add');add.type='button';add.setAttribute('aria-haspopup','true')
 add.addEventListener('click',()=>openTagPicker(add,{id:latest.id,current:(d.tags||[]).map(t=>t.id),onSaved:onChanged}))
 tagRow.append(add);tagSec.append(tagRow);box.append(tagSec)
 // ประวัติย่อ: ทุกช่องทางของลูกค้าคนนี้
 const hist=text('section','','cust-sec');hist.append(text('h3','ประวัติการคุย ('+convs.length+')'))
 const ul=text('ul','','cust-history')
 for(const c of convs){
  const li=text('li','','cust-conv'+(c.id===currentId?' current':''))
  const top=text('div','','cust-conv-top');top.append(channelBadge(c.channel),stagePill(c.stage),text('span',c.last_message_at?date(c.last_message_at):'—','muted cust-conv-time'))
  li.append(top,text('p',c.last_message_preview||'ยังไม่มีข้อความ','cust-conv-preview'))
  const meta=text('div','','cust-conv-meta');meta.append(slaPill(c.sla,c.waiting_minutes),text('span',c.status==='resolved'?'ปิดแล้ว':(c.assignee_name||'ยังไม่มีคนรับ'),'muted'))
  if(c.id!==currentId){
   const go=text(mode==='chat'?'button':'a','เปิดแชท','cust-open');
   if(mode==='chat'){go.type='button';go.addEventListener('click',()=>selectCase(c.id).catch(e=>note(e.message,true)))}else go.href='/?open='+encodeURIComponent(c.id)
   meta.append(go)
  }else meta.append(text('span','กำลังเปิดอยู่','muted'))
  li.append(meta);ul.append(li)
 }
 hist.append(ul);box.append(hist)
 return box
}

// แผงขวาในหน้าแชท: วาง drawer ไว้บนสุด ฟอร์มแก้ข้อมูล/ติดตาม/นัดชมเดิมอยู่ถัดลงไป
let custSeq=0
async function renderCustomerPanel(){
 const id=selected,seq=++custSeq;if(!id)return
 let host=$('cust-panel')
 if(!host){host=text('div','','cust-panel');host.id='cust-panel';$('lead-details').prepend(host)}
 try{
  const d=await api('contact_detail',{conversation_id:id})
  if(seq!==custSeq||id!==selected)return
  host.replaceChildren(customerDrawer(d,{mode:'chat',currentId:id,onChanged:async()=>{await reloadFlags();await refreshTags();renderFilters();await renderCustomerPanel()}}))
 }catch(e){if(seq===custSeq)host.replaceChildren(text('p','โหลดข้อมูลลูกค้าไม่สำเร็จ: '+e.message,'muted'))}
}

// ───────────────────────────────────────── หน้า "รายชื่อติดต่อ" (/contacts)
// ★ ไม่แก้เวลาใด ๆ ของข้อความ · SLA/ระยะ/เบอร์ mask มาจากฐาน · ทำหลายแถวใช้ RPC เดิมทีละแถวแล้วรายงานผลจริง
const contactsState={search:'',tag_id:'',stage:'',assignee:'',channel:'',sla:'',starred:false,sort:'desc',offset:0}
let contactRows=[],contactSel=new Set(),contactsSeq=0
function mountContacts(){
 document.body.classList.add('contacts-view')
 const title=document.querySelector('.nav-page-title');if(title)title.textContent='รายชื่อติดต่อ'
 const view=text('section','','contacts');view.id='contacts-view';view.setAttribute('aria-labelledby','contacts-title')
 document.querySelector('#workspace > main').before(view)
 const h=text('div','','contacts-head');const t=text('h1','รายชื่อติดต่อ');t.id='contacts-title'
 const about=text('button','เกี่ยวกับระยะ','subtle contacts-about');about.type='button';about.addEventListener('click',openStageHelp)
 h.append(t,about)
 const tools=text('div','','contacts-tools')
 const q=document.createElement('input');q.type='search';q.placeholder='ค้นหาชื่อหรือเบอร์';q.setAttribute('aria-label','ค้นหาชื่อหรือเบอร์')
 let timer;q.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>{contactsState.search=q.value;contactsState.offset=0;loadContacts()},300)})
 const sel=(key,label,opts)=>{const s=document.createElement('select');s.setAttribute('aria-label',label);s.append(Object.assign(text('option',label),{value:''}));for(const [v,l] of opts)s.append(Object.assign(text('option',l),{value:v}));s.addEventListener('change',()=>{contactsState[key]=s.value;contactsState.offset=0;loadContacts()});return s}
 const tagSel=sel('tag_id','แท็กทั้งหมด',tagState.tags.map(x=>[x.id,x.name]));tagSel.id='contacts-tag'
 const assignees=[['none','ยังไม่มีคนรับ'],...(boot.assignees||[]).map(a=>[a.id,a.name])]
 const sortSel=document.createElement('select');sortSel.setAttribute('aria-label','เรียง');for(const [v,l] of [['desc','แชทล่าสุดก่อน'],['asc','แชทเก่าสุดก่อน']])sortSel.append(Object.assign(text('option',l),{value:v}))
 sortSel.addEventListener('change',()=>{contactsState.sort=sortSel.value;contactsState.offset=0;loadContacts()})
 const starBtn=text('button','★ ติดดาว','chip');starBtn.type='button';starBtn.setAttribute('aria-pressed','false')
 starBtn.addEventListener('click',()=>{contactsState.starred=!contactsState.starred;starBtn.classList.toggle('selected',contactsState.starred);starBtn.setAttribute('aria-pressed',String(contactsState.starred));contactsState.offset=0;loadContacts()})
 tools.append(q,tagSel,sel('stage','ระยะทั้งหมด',STAGES.map(s=>[s[0],s[1]])),sel('assignee','ผู้รับผิดชอบทั้งหมด',assignees),sel('channel','ทุกช่องทาง',CHANNELS),sel('sla','SLA ทั้งหมด',[['over','เกิน SLA'],['near','ใกล้เกิน'],['ok','ปกติ']]),starBtn,sortSel)
 const bulk=text('div','','contacts-bulk');bulk.id='contacts-bulk';bulk.hidden=true
 const table=text('div','','contacts-table');table.id='contacts-table';table.setAttribute('role','table');table.setAttribute('aria-label','รายชื่อติดต่อ')
 const paging=text('div','','paging contacts-paging')
 const prev=text('button','← ก่อนหน้า');prev.type='button';prev.id='contacts-prev';prev.addEventListener('click',()=>{contactsState.offset=Math.max(0,contactsState.offset-50);loadContacts()})
 const next=text('button','ถัดไป →');next.type='button';next.id='contacts-next';next.addEventListener('click',()=>{contactsState.offset+=50;loadContacts()})
 paging.append(prev,next)
 view.append(h,tools,bulk,table,paging)
 loadContacts()
}
async function loadContacts(){
 const seq=++contactsSeq
 const table=$('contacts-table');table.setAttribute('aria-busy','true')
 try{
  const rows=await api('contacts_list',contactsQuery(contactsState))
  if(seq!==contactsSeq)return
  contactRows=rows.slice(0,50)
  $('contacts-next').disabled=rows.length<=50;$('contacts-prev').disabled=contactsState.offset===0
  contactSel=new Set([...contactSel].filter(id=>contactRows.some(r=>r.contact_id===id)))
  renderContacts()
 }catch(e){if(seq===contactsSeq){table.replaceChildren(text('p','โหลดรายชื่อไม่สำเร็จ: '+e.message,'muted contacts-empty'))}}
 finally{if(seq===contactsSeq)table.removeAttribute('aria-busy')}
}
function renderContacts(){
 const table=$('contacts-table')
 const hr=text('div','','contacts-tr contacts-th');hr.setAttribute('role','row')
 const all=document.createElement('input');all.type='checkbox';all.setAttribute('aria-label','เลือกทั้งหน้า')
 all.checked=contactRows.length>0&&contactRows.every(r=>contactSel.has(r.contact_id))
 all.addEventListener('change',()=>{for(const r of contactRows)all.checked?contactSel.add(r.contact_id):contactSel.delete(r.contact_id);renderContacts()})
 const cell=(el,cls='')=>{const c=text('div','','contacts-td '+cls);c.setAttribute('role','cell');typeof el==='string'?c.textContent=el:c.append(el);return c}
 hr.append(cell(all,'c-check'));for(const [l,c] of [['โปรไฟล์','c-profile'],['แท็ก','c-tags'],['ระยะ','c-stage'],['ผู้รับผิดชอบ','c-owner'],['เบอร์','c-phone'],['แชทล่าสุด','c-last'],['','c-actions']]){const x=cell(l,c);x.setAttribute('role','columnheader');hr.append(x)}
 table.replaceChildren(hr)
 for(const r of contactRows){
  const tr=text('div','','contacts-tr'+(contactSel.has(r.contact_id)?' selected':''));tr.setAttribute('role','row')
  const name=customerName(r.display_name,'',r.channels?.[0])
  const cb=document.createElement('input');cb.type='checkbox';cb.checked=contactSel.has(r.contact_id);cb.setAttribute('aria-label','เลือก '+name)
  cb.addEventListener('change',()=>{cb.checked?contactSel.add(r.contact_id):contactSel.delete(r.contact_id);tr.classList.toggle('selected',cb.checked);renderBulk();all.checked=contactRows.every(x=>contactSel.has(x.contact_id))})
  const prof=text('div','','c-profile-box');prof.append(avatar(boot?.user?.test_only?'':r.picture_url,name))
  const nm=text('div','','c-name');const strong=text('strong',name);if(r.starred){const s=starIcon();s.classList.add('c-star');strong.prepend(s)}
  const chs=text('div','','cust-channels');for(const ch of r.channels||[])chs.append(channelBadge(ch));nm.append(strong,chs);prof.append(nm)
  const tags=text('div','','c-tag-list');const ct=cardTags(r.tags,2);for(const t of ct.shown)tags.append(tagChip(t,'card-tag'));if(ct.more)tags.append(text('span','+'+ct.more,'card-tag more'))
  const last=text('div','','c-last-box');last.append(text('span',r.last_message_at?listTime(r.last_message_at):'—','c-time'),slaPill(r.sla,r.waiting_minutes))
  if(r.last_message_at)last.title=date(r.last_message_at)
  const acts=text('div','','c-actions-box')
  const open=text('a','เปิดแชท','c-open');open.href='/?open='+encodeURIComponent(r.conversation_id)
  const more=text('button','รายละเอียด','subtle');more.type='button';more.addEventListener('click',()=>openContactDrawer(r.conversation_id,more))
  acts.append(open,more)
  tr.append(cell(cb,'c-check'),cell(prof,'c-profile'),cell(tags,'c-tags'),cell(stagePill(r.stage),'c-stage'),cell(r.assignee_name||'ยังไม่มีคนรับ','c-owner'),cell(r.phone||'—','c-phone'),cell(last,'c-last'),cell(acts,'c-actions'))
  table.append(tr)
 }
 if(!contactRows.length)table.append(text('p','ไม่พบรายชื่อตามเงื่อนไขนี้','muted contacts-empty'))
 renderBulk()
}
// แถบทำหลายแถว: ติดแท็ก · มอบหมาย · ส่ง LINE หลายคน (ยังปิดไว้ — ดู narrowcastBlocked)
function renderBulk(){
 const bar=$('contacts-bulk');if(!bar)return
 bar.hidden=contactSel.size===0;if(bar.hidden)return
 const picked=contactRows.filter(r=>contactSel.has(r.contact_id))
 const tagS=document.createElement('select');tagS.setAttribute('aria-label','ติดแท็กให้ที่เลือก');tagS.append(Object.assign(text('option','ติดแท็ก…'),{value:''}));for(const x of tagState.tags)tagS.append(Object.assign(text('option',x.name),{value:x.id}))
 tagS.addEventListener('change',async()=>{const tag=tagS.value;if(!tag)return;tagS.disabled=true
  const res=[];for(const r of picked){try{await api('case_tags_set',{conversation_id:r.conversation_id,add:[tag]});res.push({ok:true})}catch(e){res.push({ok:false,code:e.code,message:e.message})}}
  note(bulkSummary('ติดแท็ก',res),res.some(x=>!x.ok));await refreshTags();await loadContacts()})
 const parts=[text('strong','เลือก '+picked.length+' รายการ'),tagS]
 if(['manager','admin','senior_sales'].includes(boot.user.role)){
  const as=document.createElement('select');as.setAttribute('aria-label','มอบหมายให้');as.append(Object.assign(text('option','มอบหมายให้…'),{value:''}));for(const a of boot.assignees||[])as.append(Object.assign(text('option',a.name),{value:a.id}))
  as.addEventListener('change',async()=>{const to=as.value;if(!to)return
   const who=(boot.assignees||[]).find(a=>a.id===to)?.name||'พนักงาน'
   if(!confirm('มอบหมาย '+picked.length+' รายการให้ '+who+'?'))return as.value=''
   as.disabled=true
   // ★ ใช้คำสั่ง transfer เดิมของ connect_api ทีละเคส (มี audit + request_id + emit ไป CRM ตามเดิม)
   //   เคสที่ยังไม่มีคนรับ ฐานจะตอบ claim_required — รายงานตามจริง ไม่ข้ามด่าน
   const res=[];for(const r of picked){try{await api('transfer',{id:r.conversation_id,assignee_id:to,request_id:crypto.randomUUID()});res.push({ok:true})}catch(e){res.push({ok:false,code:e.code,message:e.message})}}
   note(bulkSummary('มอบหมาย',res,{claim_required:'ยังไม่มีคนรับเคส (ต้องรับเคสก่อน)',case_closed:'เคสปิดแล้ว',assignee_not_allowed:'มอบให้คนนี้ไม่ได้'}),res.some(x=>!x.ok));await loadContacts()})
  parts.push(as)
 }
 const nc=text('button','ส่ง LINE หลายคน','subtle');nc.type='button';nc.addEventListener('click',()=>narrowcastBlocked(picked));parts.push(nc)
 const clear=text('button','ยกเลิกเลือก','subtle');clear.type='button';clear.addEventListener('click',()=>{contactSel.clear();renderContacts()});parts.push(clear)
 bar.replaceChildren(...parts)
}
// ★ narrowcast ยังไม่เปิด — ขาดข้อมูลที่ต้องมีก่อนส่งจริง (ไม่เดา): แหล่ง consent, สิทธิ์ใครส่งได้, ช่อง LINE OA ไหน
function narrowcastBlocked(picked){
 const lineN=picked.filter(r=>(r.channels||[]).includes('line')).length
 let dlg=$('nc-dialog');if(!dlg){dlg=document.createElement('dialog');dlg.id='nc-dialog';dlg.className='tag-admin';document.body.append(dlg)}
 const head=text('div','','tag-admin-head');const x=text('button','×','icon-btn tag-admin-close');x.type='button';x.setAttribute('aria-label','ปิด');x.addEventListener('click',()=>dlg.close())
 head.append(text('h2','ส่ง LINE หลายคน — ยังเปิดใช้ไม่ได้'),x)
 const body=text('div','','tag-admin-form')
 body.append(text('p','เลือกไว้ '+picked.length+' รายการ · มีช่อง LINE '+lineN+' รายการ (ช่องอื่นส่งแบบนี้ไม่ได้)'))
 body.append(text('p','ยังไม่ได้ส่งอะไรออกไป ต้องตกลงเรื่องเหล่านี้ก่อนจึงจะเปิดปุ่มส่ง:'))
 const ul=text('ul','','nc-needs');for(const s of ['ข้อมูลความยินยอม (consent) ของลูกค้าเก็บไว้ที่ไหน — ตอนนี้ฐานยังไม่มีช่องนี้','ใครส่งได้ (role) และจำกัดจำนวนต่อครั้ง/ต่อวันเท่าไร','ใช้ LINE OA ช่องไหน (Naii / Vibe) และโควตาข้อความของแพ็กเกจ'])ul.append(text('li',s))
 body.append(ul);dlg.replaceChildren(head,body);if(!dlg.open)dlg.showModal()
}
async function openContactDrawer(conversationId,from){
 let dr=$('contact-drawer')
 if(!dr){dr=document.createElement('dialog');dr.id='contact-drawer';dr.className='contact-drawer';dr.setAttribute('aria-label','รายละเอียดลูกค้า');document.body.append(dr)
  dr.addEventListener('click',e=>{if(e.target===dr)dr.close()})}
 const head=text('div','','tag-admin-head');const x=text('button','×','icon-btn tag-admin-close');x.type='button';x.setAttribute('aria-label','ปิด');x.addEventListener('click',()=>dr.close())
 head.append(text('h2','รายละเอียดลูกค้า'),x)
 dr.replaceChildren(head,text('p','กำลังโหลด…','muted cust-loading'));if(!dr.open)dr.showModal()
 dr.onclose=()=>from?.focus()
 try{
  const d=await api('contact_detail',{conversation_id:conversationId})
  dr.replaceChildren(head,customerDrawer(d,{mode:'contacts',onChanged:async()=>{await refreshTags();await loadContacts();await openContactDrawer(conversationId,from)}}))
 }catch(e){dr.replaceChildren(head,text('p','โหลดไม่สำเร็จ: '+e.message,'muted cust-loading'))}
}
function openStageHelp(){
 let dlg=$('stage-help');if(!dlg){dlg=document.createElement('dialog');dlg.id='stage-help';dlg.className='tag-admin';document.body.append(dlg)}
 const head=text('div','','tag-admin-head');const x=text('button','×','icon-btn tag-admin-close');x.type='button';x.setAttribute('aria-label','ปิด');x.addEventListener('click',()=>dlg.close())
 head.append(text('h2','เกี่ยวกับระยะ'),x)
 const body=text('div','','tag-admin-form')
 body.append(text('p','ระบบคิดระยะจากข้อมูลจริง ไม่ได้ตั้งเอง: ขั้นในดีล (CRM) และมีพนักงานตอบแล้วหรือยัง','muted'))
 const dl=text('dl','','stage-help-list');for(const [,l,c,desc] of STAGES){const dt=document.createElement('dt');dt.append(Object.assign(text('span',l,'tag-chip tag-'+c)));dl.append(dt,text('dd',desc))}
 body.append(dl,text('p','SLA: เกิน = ลูกค้ารอเกินเวลาที่ตั้งไว้ · ใกล้เกิน = รอเกินครึ่งหนึ่งแล้ว · ปกติ = ไม่มีใครรอ — นับจากข้อความจริง หักช่วง 00:00–06:00','muted'))
 dlg.replaceChildren(head,body);if(!dlg.open)dlg.showModal()
}

function renderChannels(){
 const box=$('channel-status');if(!box)return
 box.replaceChildren()
 if(!boot.channels.length){box.append(text('span','ยังไม่ได้เชื่อมช่องทางแชท','channel-chip off'));return}
 for(const c of boot.channels){
  const state=c.state||(c.enabled?'ok':'off')
  const chip=text('span','','channel-chip '+state)
  const dot=text('span','','dot');dot.setAttribute('aria-hidden','true')
  chip.append(dot,text('span',shortChannel(c),'label'))
  // สีบอกว่าตอนนี้เป็นยังไง ส่วน hover บอกว่าทำไม — สองคำถามที่คนถามต่อกันเสมอ
  const lines=[c.name+' · '+(channelState[state]||state)]
  if(c.last_message_at)lines.push('ข้อความล่าสุด '+date(c.last_message_at))
  else if(state!=='off')lines.push('ยังไม่เคยมีข้อความเข้ามา')
  if(c.reason)lines.push(c.reason)
  chip.title=lines.join(String.fromCharCode(10))
  chip.setAttribute('aria-label',lines.join(' · '))
  box.append(chip)
 }
}
// ─────────────────────────────────────────── หน้าจอมือถือ (เฟส 4.1)
// ★ เกณฑ์ 767.98 ต้องตรงกับใน app.css เป๊ะ ๆ ไม่งั้นจะมีช่วงความกว้างที่
//   JS คิดว่าเป็นมือถือแต่ CSS คิดว่าเป็นจอคอม แล้วหน้าจอจะพังแบบหาสาเหตุยาก
const MOBILE = window.matchMedia('(max-width: 767.98px)')

// เปิดเคสบนมือถือ = แชทเต็มจอ ไม่ต้องเลื่อนผ่านรายการเคสทุกครั้ง
// บนจอคอมคลาสนี้ไม่มีผล เพราะกฎทั้งหมดอยู่ใน @media ของมือถือ
// ★ เปิดแชทเต็มจอ/แผงข้อมูลลูกค้าบนมือถือ = เพิ่มรายการใน history หนึ่งชั้น
//   ปุ่มย้อนกลับของ Android (และ swipe back ของ iOS) จึงเป็นการ "ปิดชั้นที่เปิดอยู่"
//   ไม่ใช่ออกจากแอป — ซึ่งเป็นสิ่งที่คนคาดหวังจากแอปแชททุกตัว
//   viaHistory=true แปลว่าคำสั่งนี้มาจาก popstate แล้ว ห้ามยุ่งกับ history ซ้ำ
function setChatOpen(on, viaHistory){
 const was=document.body.classList.contains('chat-open')
 const next=Boolean(on)&&MOBILE.matches
 document.body.classList.toggle('chat-open', next)
 if(viaHistory||next===was)return
 if(next)history.pushState({connect:'chat'},'')
 else history.back()
}
function setLeadOpen(on, viaHistory){
 const was=document.body.classList.contains('lead-open')
 const next=Boolean(on)
 document.body.classList.toggle('lead-open', next)
 $('toggle-lead')?.setAttribute('aria-expanded',String(next))
 // บนจอคอมแผงนี้เป็นพาเนลข้างที่ไม่ได้กินทั้งหน้าจอ จึงไม่ควรไปกินปุ่มย้อนกลับของเบราว์เซอร์
 if(viaHistory||!MOBILE.matches||next===was)return
 if(next)history.pushState({connect:'lead'},'')
 else history.back()
}
window.addEventListener('popstate',()=>{
 // ปิดชั้นบนสุดก่อนเสมอ: แผงข้อมูลลูกค้าทับอยู่บนแชทเต็มจอ
 if(document.body.classList.contains('lead-open'))return setLeadOpen(false,true)
 if(document.body.classList.contains('chat-open'))setChatOpen(false,true)
})
$('back').addEventListener('click',()=>{ setChatOpen(false); $('conversations').scrollIntoView({block:'start'}) })
// หมุนจอกลางคัน: ถ้ากว้างเกินเกณฑ์แล้วต้องคืนสภาพเอง ไม่งั้นค้างเป็นแชทเต็มจอบนจอคอม
MOBILE.addEventListener('change',e=>{ if(!e.matches) document.body.classList.remove('chat-open','kb-open'); if(items.length)renderList() })

// ความสูงที่มองเห็นจริง — คีย์บอร์ดทับจออยู่ข้างบนโดยที่ 100dvh ไม่ลดตามในหลายเบราว์เซอร์
// ถ้าไม่ตั้งค่านี้ ช่องพิมพ์จะถูกดันลงไปอยู่ใต้คีย์บอร์ด พิมพ์แล้วไม่เห็นสิ่งที่พิมพ์
const vv = window.visualViewport
if (vv) {
 const syncViewport = () => {
  document.documentElement.style.setProperty('--vh-visible', vv.height + 'px')
  // เหลือพื้นที่น้อยกว่า 3 ใน 4 ของจอ = คีย์บอร์ดเปิดอยู่
  document.body.classList.toggle('kb-open', MOBILE.matches && vv.height < window.innerHeight * 0.75)
  if (document.body.classList.contains('chat-open')) $('messages').scrollTop = $('messages').scrollHeight
 }
 vv.addEventListener('resize', syncViewport)
 vv.addEventListener('scroll', syncViewport)
 syncViewport()
}

// Enter = ส่ง เฉพาะจอคอม · Shift+Enter = ขึ้นบรรทัดใหม่
// ★ บนมือถือ Enter ต้องขึ้นบรรทัดใหม่เสมอ เพราะคีย์บอร์ดมือถือไม่มีปุ่ม Shift ที่ใช้ร่วมได้จริง
//   และการเผลอส่งข้อความครึ่งประโยคให้ลูกค้าย้อนคืนไม่ได้
$('message').addEventListener('keydown',e=>{
 if(e.key!=='Enter'||e.shiftKey||e.isComposing||MOBILE.matches)return
 e.preventDefault()
 if(!$('send').disabled)$('reply').requestSubmit()
})

// ★ ย้าย element จริง ไม่ใช่สร้างปุ่มใหม่ซ้อน — id="refresh" ยังเป็นตัวเดิม event listener
//   เดิมยังผูกอยู่ถูกตัว แค่ตำแหน่งใน DOM ย้ายเข้าแถบเมนูบนแถวเดียวกับตั้งค่า/สถิติ
//   (รวมทุกเมนูอยู่ tab เดียว ไม่มีแถวหัว "แชท" แยกอีกแถวแล้ว) ต่อท้าย #nav-settings
//   เพื่อให้ margin-left:auto ของ #nav-settings ดันทั้งคู่ไปชิดขวาด้วยกัน
function relocateRefreshButton(){
 // จอกว้างเมนูเป็นแถบข้างซ้ายแล้ว ปุ่มรีเฟรชอยู่ที่หัวรายการแชทตามเดิม · ย้ายเข้าแถบบนเฉพาะมือถือ
 if(!MOBILE.matches)return
 const btn=$('refresh'),nav=$('app-nav')
 if(btn&&nav)nav.append(btn)
}
// ── แถบเมนูซ้าย (แบบ LINE OA Manager) ──────────────────────────────────
// จอ ≥768: แถบข้างซ้าย กาง 220 / ยุบ 64 (ไอคอนอย่างเดียว) จำสถานะใน localStorage ร่วมทุกหน้า
// จอแคบยังเป็นแถบบนแบบเดิม — ปุ่มซ่อนเมนู/รายการเสริมถูกซ่อนด้วย CSS
const NAV_KEY='connect.nav.collapsed'
const ICON_BROADCAST='M4 10v4h3l5 4V6L7 10zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12'
const ICON_TAG='M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-6.9 6.9a1 1 0 0 1-1.4 0zM8 8h.01'
const ICON_COLLAPSE='M4 5h16v14H4zM9 5v14M15.5 9.5 13 12l2.5 2.5'
const ICON_MENU='M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'
const ICON_LOGOUT='M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10'
function navButton(id,label,path,extra=''){
 const b=document.createElement('button');b.type='button';b.className='nav-item '+extra;b.id=id;b.title=label;b.setAttribute('aria-label',label)
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','nav-icon');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false')
 const pa=document.createElementNS('http://www.w3.org/2000/svg','path');pa.setAttribute('d',path);pa.setAttribute('fill','none');pa.setAttribute('stroke','currentColor');pa.setAttribute('stroke-width','1.8');pa.setAttribute('stroke-linecap','round');pa.setAttribute('stroke-linejoin','round')
 svg.append(pa);b.append(svg,text('span',label,'nav-label'));return b
}
function setNavCollapsed(on){
 document.documentElement.classList.toggle('nav-collapsed',on)
 try{localStorage.setItem(NAV_KEY,on?'1':'0')}catch{/* โหมดส่วนตัว: จำไม่ได้ก็ไม่เป็นไร */}
 const t=$('nav-collapse');if(!t)return
 const label=on?'แสดงเมนู':'ซ่อนเมนู'
 t.setAttribute('aria-expanded',String(!on));t.title=label;t.setAttribute('aria-label',label);t.querySelector('.nav-label').textContent=label
}
function buildSideNav(role){
 const nav=$('app-nav');if(!nav||$('nav-collapse'))return
 const stats=$('nav-stats'),settings=$('nav-settings')
 const bc=navButton('nav-broadcast','ส่งข้อความหลายคน',ICON_BROADCAST,'nav-extra');bc.disabled=true;bc.title='ส่งข้อความหลายคน (เร็ว ๆ นี้)'
 bc.hidden=!['manager','admin'].includes(role)
 const tg=navButton('nav-tags','จัดการแท็ก',ICON_TAG,'nav-extra');tg.hidden=!!boot?.user?.test_only
 tg.addEventListener('click',async()=>{await refreshTags();openTagAdmin()})
 // ลำดับเหมือน LINE OA: แชท · รายชื่อติดต่อ · ส่งข้อความหลายคน · สถิติ · แท็ก ··· ตั้งค่า · ซ่อนเมนู
 if(stats)stats.before(bc);else settings?.before(bc)
 settings?.before(tg)
 const col=navButton('nav-collapse','ซ่อนเมนู',ICON_COLLAPSE,'nav-extra nav-collapse');col.setAttribute('aria-controls','app-nav')
 col.addEventListener('click',()=>setNavCollapsed(!document.documentElement.classList.contains('nav-collapsed')))
 nav.append(col)
 setNavCollapsed(document.documentElement.classList.contains('nav-collapsed'))
 // มือถือ: ปุ่ม "เมนู" เปิดหน้าหลักแบบ LINE OA (ไทล์ใหญ่) — สถิติ/ตั้งค่าย้ายเข้าไปอยู่ในนั้น
 const home=navButton('nav-home','เมนู',ICON_MENU,'nav-mobile');home.setAttribute('aria-haspopup','dialog')
 home.addEventListener('click',openMobileMenu)
 ;(settings||col).before(home)
}
// หน้าหลักบนมือถือ — ไทล์ทุกเมนูที่ role นี้เห็นในแถบซ้าย กดแล้วทำงานเหมือนกดเมนูเดิมทุกอย่าง
// (เรียก .click() ของปุ่มเดิม ไม่เขียนพฤติกรรมซ้ำ) · เมนูที่ซ่อน/ปิดอยู่ก็ซ่อน/ปิดในนี้ด้วย
function openMobileMenu(){
 let dlg=$('mobile-menu')
 if(!dlg){dlg=document.createElement('dialog');dlg.id='mobile-menu';dlg.className='mobile-menu';dlg.setAttribute('aria-labelledby','mobile-menu-title');document.body.append(dlg)}
 const head=text('div','','tag-admin-head');const t=text('h2','เมนู');t.id='mobile-menu-title'
 const x=text('button','×','icon-btn tag-admin-close');x.type='button';x.setAttribute('aria-label','ปิด');x.addEventListener('click',()=>dlg.close())
 head.append(t,x)
 const who=text('p','','mobile-menu-user muted');who.textContent=(boot?.user?.email||'')+(boot?.user?.role?' · '+boot.user.role:'')
 const grid=text('div','','mobile-menu-grid')
 const sources=[document.querySelector('.nav-item[data-nav="chat"]'),$('nav-customers'),$('nav-broadcast'),$('nav-stats'),$('nav-tags'),$('nav-settings')]
 for(const src of sources){
  if(!src||src.hidden)continue
  const label=src.querySelector('.nav-label')?.textContent||src.getAttribute('aria-label')||''
  const tile=text('button','','mobile-tile'+(src.classList.contains('active')?' active':''));tile.type='button';tile.disabled=!!src.disabled
  const icon=src.querySelector('svg')?.cloneNode(true);if(icon)tile.append(icon)
  tile.append(text('span',label,'mobile-tile-label'))
  if(src.disabled)tile.append(text('small','เร็ว ๆ นี้','muted'))
  const badge=src.querySelector('.nav-badge');if(badge&&!badge.hidden)tile.append(text('span',badge.textContent,'nav-badge mobile-tile-badge'))
  tile.addEventListener('click',()=>{dlg.close();src.click()})
  grid.append(tile)
 }
 const out=text('button','','mobile-tile mobile-tile-logout');out.type='button'
 const ov=navButton('x','',ICON_LOGOUT).querySelector('svg');out.append(ov,text('span','ออกจากระบบ','mobile-tile-label'))
 out.addEventListener('click',()=>{dlg.close();$('logout').click()})
 grid.append(out)
 dlg.replaceChildren(head,who,grid)
 if(!dlg.open)dlg.showModal()
}
// เมนูสถิติ/ตั้งค่า — ใช้เงื่อนไข role เดียวกับ #stats-link เดิม (ไม่ได้คิดกฎสิทธิ์ใหม่)
// "ลูกค้า" ปิดด้วย feature flag เสมอในรอบนี้ — โมดูล CRM ยังไม่ได้สร้าง
function wireAppNav(role){
 const managerUp=['manager','admin'].includes(role)
 $('nav-stats').hidden=!managerUp
 buildSideNav(role)
 // ★ "รายชื่อติดต่อ" เปิดแล้ว (หน้า /contacts) — แต่ก่อนซ่อนไว้รอโมดูล CRM
 const cust=$('nav-customers')
 if(cust){
  cust.hidden=false;cust.disabled=false;cust.title='รายชื่อติดต่อ';cust.setAttribute('aria-label','รายชื่อติดต่อ')
  const lbl=cust.querySelector('.nav-label');if(lbl)lbl.textContent='รายชื่อติดต่อ'
  cust.addEventListener('click',()=>{if(!CONTACTS_VIEW)location.href='/contacts'})
 }
 if(CONTACTS_VIEW){
  document.querySelector('.nav-item[data-nav="chat"]')?.classList.remove('active')
  cust?.classList.add('active');cust?.setAttribute('aria-current','page')
  document.querySelector('.nav-item[data-nav="chat"]')?.addEventListener('click',()=>{location.href='/'})
 }
 // ตั้งค่า: สลับการมองเห็นของ header เดิม (แบรนด์/สวิตช์โหมดส่ง/บอท/อีเมล/ออกจากระบบ)
 // ไม่ได้ย้าย element เดิม — กัน id ซ้ำและ event listener หลุด (ดูคอมเมนต์ใน app.css)
 $('nav-settings').addEventListener('click',()=>{
  const open=document.body.classList.toggle('settings-open')
  $('nav-settings').setAttribute('aria-expanded',String(open))
 })
 // ไอคอนรูปคนบนหัวแชท = เปิด/ปิดแผงข้อมูลลูกค้า (ค่าเริ่มต้นปิด ตามสเปกเฟส 1)
 $('toggle-lead').addEventListener('click',()=>setLeadOpen(!document.body.classList.contains('lead-open')))
 $('lead-close').addEventListener('click',()=>setLeadOpen(false))
 // กดแท็บ "แชท" ซ้ำตอนเปิดแผงสนทนาอยู่บนมือถือ = กลับไปหน้ารายการ (ทางเดียวกับปุ่ม #back)
 document.querySelector('.nav-item[data-nav="chat"]')?.addEventListener('click',()=>{
  if(document.body.classList.contains('chat-open'))setChatOpen(false)
 })
}
async function start(){boot=await api('bootstrap');$('login-panel').hidden=true;$('workspace').hidden=false;await refreshBot();$('user').textContent=boot.user.email;$('stats-link').hidden=!['manager','admin'].includes(boot.user.role);relocateRefreshButton();wireAppNav(boot.user.role);if(CONTACTS_VIEW){await refreshTags();mountContacts();return}renderChannels();$('project').replaceChildren();for(const p of boot.projects){const o=text('option',p.name);o.value=p.id;$('project').append(o)}filter=readFilter();writeFilter();renderFilters();await loadList()
 // ปุ่ม "เปิดแชท" จากหน้ารายชื่อติดต่อมาที่ /?open=<id> — เปิดเคสแล้วลบพารามิเตอร์ออก รีเฟรชจะได้ไม่เปิดซ้ำ
 const openId=new URLSearchParams(location.search).get('open')
 if(openId&&/^[0-9a-f-]{36}$/i.test(openId)){const u=new URL(location.href);u.searchParams.delete('open');history.replaceState(null,'',u);try{await selectCase(openId)}catch(e){note('เปิดบทสนทนาไม่สำเร็จ: '+e.message,true)}}}
setInterval(async()=>{if(!boot||busy||polling||document.hidden||CONTACTS_VIEW)return;polling=true;const id=selected,seq=sequence;try{await refreshBot();await loadList();if(id){const next=await api('messages',{id});if(id!==selected||seq!==sequence||busy)return;const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<80;if(JSON.stringify(next.messages)!==JSON.stringify(detail.messages)){detail.messages=next.messages;renderMessages(next.messages);if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight}detail.conversation=next.conversation;renderDue(next.state||{},next.conversation.status==='resolved');detail.case_status=next.case_status;
 // ★ เตือนเมื่อ "คนอื่น" ตอบแทรกระหว่างที่เรากำลังพิมพ์ — คิวรวมแปลว่าสองคนหยิบเคสเดียวกันได้
 //   เตือนเฉพาะตอนที่ในช่องพิมพ์มีข้อความค้างอยู่ ไม่งั้นจะเด้งรบกวนทุกครั้งที่เพื่อนตอบ
 {const before=detail.last_agent_reply,after=next.last_agent_reply
  if(after&&after.at!==(before&&before.at)&&after.by!==boot?.user?.id&&$('message').value.trim())
    note((after.name||'เพื่อนร่วมทีม')+' เพิ่งตอบเคสนี้ไปเมื่อ '+date(after.at)+' ตรวจก่อนส่งซ้ำ',true)
  detail.last_agent_reply=after}
 const wait=sla(next.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;permissions()}}catch(e){note(e.message,true)}finally{polling=false}},10000)
window.addEventListener('beforeunload',e=>{if(dirty||$('message').value.trim()){e.preventDefault();e.returnValue=''}})
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('login-submit');btn.disabled=true;$('login-error').textContent='';try{await request('/api/login',{email:$('login-email').value,password:$('login-password').value});$('login-password').value='';location.replace('/')}catch(e){$('login-error').textContent=e.message}finally{btn.disabled=false}})
$('logout').addEventListener('click',async()=>{if((dirty||$('message').value.trim())&&!confirm('มีข้อความหรือข้อมูลที่ยังไม่ได้บันทึก ต้องการออกจากระบบหรือไม่?'))return;$('logout').disabled=true;try{await request('/api/logout',{});dirty=false;$('message').value='';location.replace('/')}catch(e){note(e.message,true);$('logout').disabled=false}})
start().catch(e=>{$('workspace').hidden=true;$('login-panel').hidden=false;if(e.code!=='session_expired')$('login-error').textContent=e.message})
