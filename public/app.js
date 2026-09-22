import { slaTag } from './sla.mjs'

const $ = id => document.getElementById(id)
const labels={mine:'งานของฉัน',unassigned:'ยังไม่มีคนรับ',waiting:'รอลูกค้าตอบ',sla:'ตอบเกิน SLA',today:'นัดหมายวันนี้',followup:'ถึงเวลาติดตาม',closed:'ปิดแล้ว',all:'ทั้งหมด'}
const channelState={ok:'รับข้อความอยู่',idle:'เงียบเกิน 24 ชั่วโมง',down:'มีปัญหา',off:'ยังไม่ได้เชื่อม',unknown:'ตรวจสถานะไม่ได้'}
const stageNames={follow_up:'ติดตาม',qualified:'Qualified',appointment:'นัดชม',walk_in:'Walk-in',booking:'Booking',sale:'Sale',lost:'ปิดแล้ว'}
const errors={invalid_credentials:'อีเมลหรือรหัสผ่านไม่ถูกต้อง',too_many_attempts:'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาที',not_allowed:'บัญชีของระบบไม่มีสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแล',session_expired:'เชื่อมต่อระบบหลังบ้านไม่ได้ กรุณารีเฟรชหน้า',channel_not_configured:'ยังไม่ได้เชื่อมบัญชีช่องทางนี้ กรุณาติดต่อผู้ดูแล',already_assigned:'มีผู้รับเคสนี้แล้ว กรุณารีเฟรช',claim_required:'กรุณารับเคสก่อนทำรายการ',version_conflict:'ข้อมูลถูกแก้ไขจากอีกหน้าจอ กรุณาเลือกเคสใหม่แล้วตรวจข้อมูล',stage_transition_not_allowed:'กรุณาดำเนินการตามลำดับสถานะ',future_appointment_required:'กรุณาเลือกวันเวลานัดในอนาคต',unit_unavailable:'ห้องนี้ไม่พร้อมจอง',booking_required:'ต้องมีใบจองก่อนบันทึก Sale',case_closed:'เคสนี้ปิดแล้ว',service_unavailable:'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่',request_rejected:'บันทึกไม่สำเร็จ กรุณาตรวจข้อมูลและลำดับสถานะ',invalid_origin:'กรุณาเปิดผ่าน URL ที่ผู้ดูแลกำหนด',shadow_mode:'ตอนนี้ระบบอยู่ในโหมดเก็บข้อมูล ยังไม่เปิดให้ส่งข้อความหาลูกค้า'}
let boot,items=[],selected=null,detail=null,filter='unassigned',offset=0,busy=false,dirty=false,sequence=0,listSequence=0,polling=false
// ── หน้าสถานะระบบ (/admin/health) ใช้เปลือกและเซสชันเดิมของแอป — ไม่มีล็อกอินแยกอีกต่อไป ──
// anonymous เปิดมาเจอฟอร์มล็อกอินเดิมบน URL เดียวกัน ล็อกอินแล้วกลับมาหน้านี้เอง
// ด่านสิทธิ์จริงอยู่ที่ health_can_view() ในฐาน (manager/admin ดูได้ · บันทึกกฎเป็นของ admin ตาม health_rule_save)
const ANSWER_VIEW = location.pathname === '/answer-hub'
const ADMIN_VIEW = location.pathname === '/admin/health'
// Small bridge for the optional Quick Replies module; no credentials or service
// role data are exposed, only the already-authorized bootstrap result.
window.asherQuickReplies = () => boot?.quick_replies?.length ? boot.quick_replies : (boot?.canned ?? [])
const drafts=new Map(),pendingCommands=new Map()
const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e}
function note(value,error=false){$('notice').hidden=!value;$('notice').textContent=value;$('notice').className='notice'+(error?' error':'')}
function safeReturnTo(value){return typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')?value:null}
function currentReturnTo(){return safeReturnTo(location.pathname+location.search)}
async function request(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){if(response.status===401&&path==='/api/command'&&boot){dirty=false;$('message').value='';const back=currentReturnTo();location.replace(back?`/?return_to=${encodeURIComponent(back)}`:'/')}const e=new Error(errors[data.error]||'ทำรายการไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่');e.code=data.error;throw e}return data}
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

function useTemplate(content){
 const { text, missing } = fillTemplate(content)
 $('message').value = text
 $('message').focus()
 if (missing.length) note('ยังไม่มีข้อมูลสำหรับ ' + missing.map(m => '{' + m + '}') .join(' ') + ' — กรุณาเติมเองก่อนส่ง', true)
}

// ── เรียงชิปตามบริบท ──
// ดูคำในข้อความล่าสุดของลูกค้า แล้วดันเทมเพลตที่เกี่ยวขึ้นหน้า
// ★ เรียงใหม่เท่านั้น ไม่ซ่อนอันไหน — ซ่อนแล้วเซลส์จะหาของที่เคยอยู่ตรงนั้นไม่เจอ
const TOPIC_WORDS = {
 ราคา: ['ราคา', 'เท่าไหร่', 'เท่าไร', 'กี่บาท', 'ล้าน', 'ผ่อน', 'ดาวน์', 'โปร'],
 แปลน: ['แปลน', 'ผัง', 'ห้อง', 'ตร.ม', 'ตรม', 'ขนาด', 'กี่ตาราง'],
 นัดชม: ['นัด', 'ดูห้อง', 'เข้าชม', 'ไปดู', 'ว่างวัน', 'เยี่ยมชม'],
 เบอร์: ['เบอร์', 'โทร', 'ติดต่อ', 'ไลน์', 'line id'],
}
function lastContactText(){
 const msgs = detail?.messages ?? []
 for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].sender_type === 'contact') return String(msgs[i].content ?? '')
 return ''
}
function rankTemplates(list){
 const hay = lastContactText().toLowerCase()
 const score = t => {
  const s = ((t.shortcut ?? '') + ' ' + (t.content ?? '')).toLowerCase()
  let n = 0
  for (const [topic, words] of Object.entries(TOPIC_WORDS)) {
   if (!words.some(w => hay.includes(w.toLowerCase()))) continue
   if (s.includes(topic.toLowerCase()) || words.some(w => s.includes(w.toLowerCase()))) n += 2
  }
  return n
 }
 return [...list].map((t, i) => ({ t, i, n: score(t) }))
   .sort((a, b) => b.n - a.n || a.i - b.i)   // คะแนนเท่ากันให้คงลำดับเดิม
   .map(x => x.t)
}

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
 if (boot?.user?.test_only) return box
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

function dueAlerts(state,closed=false){if(closed)return [];const now=Date.now();return [['appointment_at','ถึงเวลานัดหมาย'],['follow_up_at','ติดตามเลยกำหนด']].filter(([key])=>state[key]&&Date.parse(state[key])<=now).map(([,label])=>label)}
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
 const data=await api('list',{filter:isProject?'all':filter,search:$('search').value.trim(),offset})
 if(seq!==listSequence)return
 const projectId=isProject?projectIdFor(PROJECT_CHIPS.find(([k])=>k===filter)?.[2]):null
 const page=isProject?data.filter(x=>x.project_id===projectId):data
 items=page.slice(0,50)
 $('next').disabled=data.length<=50;$('previous').disabled=offset===0
 renderList();await refreshCounts()}
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
async function selectCase(id){if(busy)return;if(dirty&&!confirm('มีข้อมูลที่ยังไม่ได้บันทึก ต้องการเปลี่ยนเคสหรือไม่?'))return;if(selected)drafts.set(selected,$('message').value);const seq=++sequence;const data=await api('detail',{id});if(seq!==sequence)return;selected=id;detail=data;items=items.map(item=>item.id===id?{...item,unread_count:0}:item);dirty=false;$('empty').hidden=true;$('chat').hidden=false;setChatOpen(true);$('lead-empty').hidden=true;$('lead-details').hidden=false;renderDetail();renderList();$('messages').scrollTop=$('messages').scrollHeight}
// รูปกับโครงการบนหัวแชท — รูปเอาจากแถวในรายการก่อน (ที่นั่นมี picture_url แน่นอน)
// แล้วค่อยถอยไปหาของใน detail เผื่อเปิดเคสที่ยังไม่อยู่ในรายการหน้านี้
function renderChatHeadExtras(who){
 const box=$('chat-avatar')
 if(box){
  const url=items.find(i=>i.id===selected)?.picture_url||detail.contact?.picture_url||''
  box.replaceChildren()
  box.textContent=initials(who)
  if(url&&!boot?.user?.test_only){
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
function renderDetail(){const c=detail.conversation,l=detail.lead||{},s=detail.state||{};const who=customerName(detail.contact.display_name,detail.contact.external_id,detail.channel);$('chat-name').textContent=who;renderContactId(detail.contact.external_id);$('chat-channel').textContent=detail.channel==='line'?'LINE':'Messenger';renderChatHeadExtras(who);const wait=sla(detail.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;$('display-name').value=detail.contact.display_name||'';$('phone').value=detail.contact.phone||'';$('budget').value=l.budget??'';$('room').value=l.interest_unit_type||'';$('interest').value=l.extra?.interest||'unknown';$('project').value=l.project_id||boot.projects[0]?.id||'';$('followup').value=local(s.follow_up_at);$('owner').textContent=boot.assignees.find(a=>a.id===c.assignee_id)?.name||'ยังไม่มีคนรับ';$('appointment-summary').textContent=s.appointment_at?date(s.appointment_at):'ยังไม่มีนัดหมาย';renderDue(s,c.status==='resolved');$('message').value=drafts.get(selected)||'';renderMessages(detail.messages);$('pipeline').replaceChildren();for(const [code,label]of Object.entries(stageNames)){if(code==='lost')continue;const b=text('button',label,l.stage_code===code?'active':'');b.addEventListener('click',()=>stage(code));$('pipeline').append(b)}$('canned').replaceChildren();for(const item of rankTemplates(boot.canned.filter(x=>x.project_id===$('project').value))){const b=text('button',item.shortcut);b.type='button';b.title=item.content;b.addEventListener('click',()=>useTemplate(item.content));$('canned').append(b)}permissions()}
async function mutate(action,data={}){if(busy||!selected)return;const id=selected;const key=JSON.stringify({id,action,data});const requestId=pendingCommands.get(key)||crypto.randomUUID();pendingCommands.set(key,requestId);setBusy(true);try{const result=await api(action,{...data,id,request_id:requestId});pendingCommands.delete(key);if(action==='send'){drafts.delete(id);$('message').value=''}$('dialog').close();dirty=false;detail=await api('detail',{id});renderDetail();await loadList();note(action==='send'?'ข้อความเข้าคิวแล้ว สถานะส่งจะแสดงใต้ข้อความ':result.booking_id?'บันทึกเอกสารจองและข้อมูล ERP แล้ว':'บันทึกข้อมูลแล้ว')}catch(e){if(e.code&&e.code!=='service_unavailable')pendingCommands.delete(key);note(e.message,true);$('dialog-error').textContent=e.message}finally{setBusy(false)}}
let dialogAction,dialogData
function dialog(title,fields,action,extra={}){dialogAction=action;dialogData=extra;$('dialog-title').textContent=title;$('dialog-fields').replaceChildren();$('dialog-error').textContent='';for(const f of fields){const label=text('label',f.label);const input=document.createElement(f.options?'select':'input');input.name=f.name;input.required=f.required!==false;if(f.options){for(const o of f.options){const option=text('option',o.label);option.value=o.value;input.append(option)}}else{input.type=f.type||'text';if(f.min!==undefined)input.min=f.min;if(f.step)input.step=f.step;if(f.value!==undefined)input.value=f.value;if(f.maxLength)input.maxLength=f.maxLength}label.append(input);$('dialog-fields').append(label)}$('dialog').showModal()}
function stage(code){if(!detail||code===detail.lead?.stage_code)return;if(code==='appointment')return appointment();if(code==='booking'){if(!detail.units.length){note('ยังไม่มีห้องพร้อมจองใน ERP กรุณาให้ผู้ดูแลเพิ่มห้องก่อน',true);return}dialog('ยืนยันการจองห้อง',[{name:'unit_id',label:'ห้อง',options:detail.units.map(u=>({value:u.id,label:u.number+' · '+Number(u.price).toLocaleString()+' บาท'}))},{name:'amount',label:'ราคาสุทธิ (บาท)',type:'number',min:1,step:'.01'},{name:'deposit',label:'เงินจอง (บาท)',type:'number',min:0,step:'.01'}],'stage',{stage:code});return}if(code==='sale'){dialog('ยืนยันปิดการขาย',[{name:'reference',label:'เลขที่สัญญา / เอกสารอ้างอิง',maxLength:200}],'stage',{stage:code});return}dialog('ยืนยันสถานะ '+stageNames[code],[],'stage',{stage:code})}
function appointment(){dialog('นัดเข้าชม · เวลาไทย',[{name:'appointment_at',label:'วันและเวลานัด',type:'datetime-local',value:local(detail.state?.appointment_at)}],'appointment')}
let botState=[]
// สถานะบอทต้องอ่านจากฐานเสมอ ไม่ใช่จำไว้ในหน้าจอ — ผู้จัดการอีกคนอาจเพิ่งกดปิดไป
async function refreshBot(){
 if (boot?.user?.test_only) { botState=[]; renderSendMode(); return }
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
 $('reply').addEventListener('submit',e=>{e.preventDefault();const value=$('message').value.trim();if(value)mutate('send',{text:value,answer_id:$('message').dataset.answerHubId||undefined})})
$('lead-form').addEventListener('input',()=>dirty=true)
$('lead-form').addEventListener('submit',e=>{e.preventDefault();mutate('save',{version:detail.state.version,display_name:$('display-name').value,phone:$('phone').value,project_id:$('project').value,budget:$('budget').value,room:$('room').value,interest:$('interest').value,follow_up_at:utc($('followup').value)})})
$('claim').addEventListener('click',()=>mutate('claim'))
$('transfer').addEventListener('click',()=>dialog('โอนเคส',[{name:'assignee_id',label:'ผู้รับผิดชอบใหม่',options:boot.assignees.map(a=>({value:a.id,label:a.name}))}],'transfer'))
$('appointment').addEventListener('click',appointment)
$('close').addEventListener('click',()=>dialog('ปิดเคส / เสีย Lead',[{name:'reason',label:'เหตุผลที่ปิดเคส',maxLength:2000}],'close'))
$('cancel').addEventListener('click',()=>$('dialog').close())
$('dialog-form').addEventListener('submit',e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));if(values.appointment_at)values.appointment_at=utc(values.appointment_at);mutate(dialogAction,{...dialogData,...values})})
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

const urlNames={all:'all',unassigned:'pending','proj-naii':'naii','proj-vibe':'vibe'}
const fromUrl=Object.fromEntries(Object.entries(urlNames).map(([k,v])=>[v,k]))
const readFilter=()=>{const v=new URL(location.href).searchParams.get('filter')||''
 return fromUrl[v]||'all'}
function writeFilter(){const u=new URL(location.href)
 u.searchParams.set('filter',urlNames[filter]||'all')
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
}

// นับทุกตัวกรองในคำขอเดียว แล้ววาดชิปใหม่
// นับไม่ได้ไม่ใช่เหตุให้หน้าจอพัง — ชิปยังกดได้ แค่ไม่มีตัวเลข
async function refreshCounts(){
 try{counts=await api('queue_counts',{search:$('search').value.trim()})}
 catch{counts={}}
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
// ── พิมพ์ "/" เปิดรายการค้นหาเทมเพลต ──
// ★ เปิดเฉพาะตอน "/" เป็นตัวแรกของช่องพิมพ์ ไม่ใช่ทุกที่ที่มี /
//   ไม่งั้นลูกค้าถามเรื่อง "24/7" หรือ "3/5 ล้าน" แล้วเมนูจะเด้งขึ้นมาขวางการพิมพ์
let templateIndex = -1
function templateMatches(q){
 const list = boot?.canned?.filter(x => x.project_id === $('project').value) ?? []
 const t = q.trim().toLowerCase()
 const ranked = rankTemplates(list)
 if (!t) return ranked.slice(0, 8)
 return ranked.filter(x => ((x.shortcut ?? '') + ' ' + (x.content ?? '')).toLowerCase().includes(t)).slice(0, 8)
}
function closeTemplateMenu(){ const b = $('template-menu'); if (b) { b.hidden = true; b.replaceChildren() } templateIndex = -1 }
function openTemplateMenu(){
 const box = $('template-menu'); if (!box) return
 const v = $('message').value
 if (!v.startsWith('/')) return closeTemplateMenu()
 const items = templateMatches(v.slice(1))
 box.replaceChildren()
 if (!items.length) {
  box.append(text('div', boot?.canned?.length ? 'ไม่พบเทมเพลตที่ตรง' : 'ยังไม่มีเทมเพลตในระบบ', 'template-empty'))
  box.hidden = false
  return
 }
 items.forEach((it, i) => {
  const b = text('button', '', 'template-item' + (i === templateIndex ? ' active' : ''))
  b.type = 'button'
  b.append(text('strong', it.shortcut ?? '(ไม่มีชื่อย่อ)'), text('small', (it.content ?? '').slice(0, 70)))
  b.addEventListener('click', () => { useTemplate(it.content); closeTemplateMenu() })
  box.append(b)
 })
 box.hidden = false
}
$('message').addEventListener('input', openTemplateMenu)
$('message').addEventListener('blur', () => setTimeout(closeTemplateMenu, 150))
$('message').addEventListener('keydown', e => {
 const box = $('template-menu')
 if (!box || box.hidden) return
 const items = [...box.querySelectorAll('.template-item')]
 if (!items.length) return
 if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
  e.preventDefault()
  templateIndex = (templateIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  openTemplateMenu()
 } else if (e.key === 'Enter' && templateIndex >= 0) {
  e.preventDefault(); e.stopPropagation()   // ★ กันไม่ให้ Enter=ส่ง ทำงานทับ
  items[templateIndex].click()
 } else if (e.key === 'Escape') { e.preventDefault(); closeTemplateMenu() }
}, true)   // ★ capture — ต้องได้สิทธิ์ก่อน handler ของ Enter=ส่ง

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
 const btn=$('refresh'),nav=$('app-nav')
 if(btn&&nav)nav.append(btn)
}
// เมนูสถิติ/ตั้งค่า — ใช้เงื่อนไข role เดียวกับ #stats-link เดิม (ไม่ได้คิดกฎสิทธิ์ใหม่)
// "ลูกค้า" ปิดด้วย feature flag เสมอในรอบนี้ — โมดูล CRM ยังไม่ได้สร้าง
function wireAppNav(role){
 const managerUp=['manager','admin'].includes(role)
 $('nav-stats').hidden=!managerUp
 // สถานะระบบ: แสดงเมนูให้ manager/admin — การซ่อนปุ่มคือความสะอาดตา
 // ด่านจริงอยู่ที่ health_can_view() ในฐาน (แตะ /api/admin/system-health ตรง ๆ ก็ตายที่นั่น)
 // การบันทึกกฎยังเป็นของ admin เท่านั้นตาม health_rule_save ในฐาน หน้าจอปิดช่องแก้ตาม can_edit
 if(!$('nav-answer-hub')&&managerUp){const a=text('a','คลังคำตอบ','nav-item');a.id='nav-answer-hub';a.href='/answer-hub';$('app-nav').append(a)}
 if($('nav-admin-status'))$('nav-admin-status').hidden=!managerUp
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
// ═══════════════════════ หน้าสถานะระบบ (/admin/health) ═══════════════════════
// ข้อมูลจาก /api/admin/system-health (เซสชันคุกกี้เดิม) — เลิกใช้ password grant แยกของหน้า standalone
// ★ overall คำนวณที่ backend จุดเดียว (server.mjs) หน้านี้แปลงเป็นคำกับสีเท่านั้น ห้ามสรุปเอง
const AH_OVERALL={healthy:['good','HEALTHY'],degraded:['warn','DEGRADED'],down:['critical','DOWN'],unknown:['gray','UNKNOWN']}
const AH_STATE={healthy:['good','ปกติ'],degraded:['warn','ต้องดู'],down:['critical','ล่ม'],warn:['warn','ต้องดู'],unknown:['gray','ยังไม่มีข้อมูล'],disabled:['gray','ปิดอยู่']}
// พารามิเตอร์หลักที่แก้ได้ต่อชนิดกฎ — ต้องตรงกับที่ health_rule_save ตรวจใน SQL
const AH_MAIN_PARAM={silence:['minutes','นาที'],fail_count:['threshold','ครั้ง'],pending_age:['minutes','นาที'],tls_days:['days','วัน'],worker_age:['minutes','นาที']}
let ahDom=null,ahBusyTest=false
async function ahFetch(path,body){
 const res=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
 if(res.status===401){location.replace('/admin/health');throw new Error('กรุณาเข้าสู่ระบบใหม่')}
 if(res.status===403)throw new Error('หน้านี้สำหรับ manager และ admin')
 const data=await res.json().catch(()=>({}))
 if(!res.ok)throw new Error(errors[data.error]||data.error||'HTTP '+res.status)
 return data
}
const ahAgo=iso=>{if(!iso)return 'ยังไม่มี';const m=Math.floor((Date.now()-new Date(iso))/60000);return m<1?'เมื่อสักครู่':m<60?m+' นาทีที่แล้ว':m<1440?Math.floor(m/60)+' ชม. ที่แล้ว':Math.floor(m/1440)+' วันที่แล้ว'}
const ahUptime=s=>{const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);return d?`${d} วัน ${h} ชม.`:h?`${h} ชม. ${m} นาที`:`${m} นาที`}
function ahPill(status){const [tone,label]=AH_STATE[status]??AH_STATE.unknown;return text('span',label,'pill '+tone)}
function ahRow(k,v,bad){const row=text('div','','ah-row');row.append(text('span',k),text('span',String(v??'—'),bad?'ah-bad-text':''));return row}
function ahCard(title,status,rows){const card=text('div','','ah-card'+(status==='down'?' ah-bad':''))
 const head=text('header');head.append(text('h3',title),ahPill(status));card.append(head)
 for(const r of rows)card.append(ahRow(r[0],r[1],r[2]))
 return card}
function ahChannelCard(label,c){if(!c)return ahCard(label,'disabled',[['ช่องทาง','ยังไม่มีในระบบ']])
 const rows=[['ช่องทาง',c.name||label],['ข้อความล่าสุด',ahAgo(c.lastWebhookAt)]]
 if(c.detail)rows.push(['เหตุผล',c.detail,c.reachable===false])
 return ahCard(label,c.status,rows)}
function buildAdminHealth(){
 const sec=text('section');sec.id='admin-health'
 const head=text('div','','ah-head')
 head.append(text('h1','สถานะระบบ'))
 const overall=text('span','…','pill gray');overall.id='ah-overall';head.append(overall)
 const refresh=text('button','รีเฟรช');refresh.id='ah-refresh';refresh.type='button';refresh.className='subtle'
 refresh.addEventListener('click',()=>{refresh.disabled=true;refreshAdminHealth().catch(e=>ahError(e.message)).finally(()=>refresh.disabled=false)})
 head.append(refresh);sec.append(head)
 const meta=text('p','','ah-meta');meta.id='ah-meta';sec.append(meta)
 const err=text('div','','notice error');err.id='ah-error';err.hidden=true;sec.append(err)
 sec.append(text('h2','ภาพรวมระบบ','ah-section'))
 const cards=text('div','','ah-grid');cards.id='ah-cards';sec.append(cards)
 sec.append(text('h2','ตรวจระบบ','ah-section'))
 const testBtn=text('button','ตรวจทุกขั้น','primary');testBtn.id='ah-test';testBtn.type='button'
 testBtn.addEventListener('click',runAdminSelfTest);sec.append(testBtn)
 const steps=text('div');steps.id='ah-steps';steps.hidden=true;sec.append(steps)
 sec.append(text('h2','กฎแจ้งเตือน','ah-section'))
 const rules=text('div');rules.id='ah-rules';sec.append(rules)
 rules.addEventListener('change',onAdminRuleChange)
 const note=text('p','','muted');note.id='ah-rule-note';sec.append(note)
 ahDom={overall,meta,err,cards,steps,testBtn,rules,note,canEdit:false}
 return sec
}
function ahError(msg){const box=ahDom?.err;if(!box)return;box.hidden=!msg;box.textContent=msg||''}
async function initAdminHealth(){
 const main=document.querySelector('#workspace main')||document.body
 main.append(buildAdminHealth())
 await refreshAdminHealth().catch(e=>ahError(e.message))
}
async function refreshAdminHealth(){const sys=await ahFetch('/api/admin/system-health');ahError('');renderAdminHealth(sys)}
function renderAdminHealth(sys){
 const [tone,label]=AH_OVERALL[sys.overall]??AH_OVERALL.unknown
 ahDom.overall.className='pill '+tone;ahDom.overall.textContent=label
 ahDom.meta.textContent=`ทำงานมา ${ahUptime(sys.uptimeSec??0)} · เวอร์ชัน ${sys.version||'—'} · เช็คล่าสุด ${sys.checkedAt?new Date(sys.checkedAt).toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok'}):'—'} · โหมดเงา ${sys.shadowMode?'ON — รับเข้าอย่างเดียว':'OFF — ส่งจริง'}`
 const cards=ahDom.cards;cards.replaceChildren()
 const db=sys.database??{}
 cards.append(ahCard('ฐานข้อมูล',db.status??'unknown',[
  ['ตอบกลับใน',db.latencyMs!=null?db.latencyMs+' ms':'ไม่ตอบ',db.latencyMs==null],
  ['สำเร็จล่าสุด',ahAgo(db.lastSuccessAt)]]))
 const ch=sys.channels??{}
 cards.append(ahChannelCard('LINE',ch.line))
 cards.append(ahChannelCard('Messenger',ch.messenger))
 const w=sys.workers??{},wi=w.inbound??{},wo=w.outbound??{}
 cards.append(ahCard('Worker ขาเข้า',wi.status??'unknown',[
  ['สำเร็จล่าสุด',ahAgo(wi.lastSuccessAt)],
  ['อายุ',wi.ageMin!=null?wi.ageMin+' นาที':'—'],
  ['เกณฑ์เตือน/วิกฤต',(wi.warnMin??'—')+' / '+(wi.critMin??'—')+' นาที']]))
 cards.append(ahCard('Worker ขาออก',wo.status??'unknown',[
  ['โหมด',wo.shadow?'เงา — ตั้งใจไม่ส่ง จึงไม่นับว่าเงียบ':'ส่งจริง'],
  ['สำเร็จล่าสุด',ahAgo(wo.lastSuccessAt)],
  ['เกณฑ์เตือน/วิกฤต',(wo.warnMin??'—')+' / '+(wo.critMin??'—')+' นาที']]))
 const q=sys.queue??{}
 cards.append(ahCard('คิวงาน',q.status??'unknown',[
  ['Pending',q.pending??'—'],['Processing',q.processing??'—'],
  ['Failed',q.failed??'—',Number(q.failed)>0],
  ['เก่าสุด',q.oldest_min!=null?q.oldest_min+' นาที':'—']]))
 renderAdminRules(sys)
}
function renderAdminRules(sys){
 ahDom.rules.replaceChildren()
 ahDom.canEdit=sys.can_edit===true
 ahDom.note.textContent=ahDom.canEdit?'เปลี่ยนกฎแล้วมีผลทันทีกับการเตือนบนระบบจริง — ทุกการบันทึกจะถามยืนยันก่อน':'เฉพาะ admin แก้กฎได้ (บัญชีนี้ดูได้อย่างเดียว)'
 for(const r of sys.rules??[]){
  const [pk,unit]=AH_MAIN_PARAM[r.kind]??[null,null]
  const row=text('div','','ah-rule'+(r.enabled?'':' off'));row.dataset.id=r.id;row.dataset.name=r.name
  const tog=document.createElement('label');tog.className='ah-toggle'
  const cb=document.createElement('input');cb.type='checkbox';cb.dataset.f='enabled';cb.checked=!!r.enabled;cb.disabled=!ahDom.canEdit;cb.setAttribute('aria-label','เปิดใช้กฎ '+r.name)
  tog.append(cb);row.append(tog)
  row.append(text('span',r.name,'ah-name'))
  const firing=r.enabled&&r.firing
  const [ftone,flabel]=firing?(AH_STATE[r.level]??AH_STATE.unknown):['gray',r.value||'ปกติ']
  row.append(text('span',flabel,'pill '+ftone))
  const ctl=text('div','','ah-ctl')
  if(pk){
   const pl=document.createElement('label');pl.className='ah-field'
   pl.append(document.createTextNode('เกิน '))
   const num=document.createElement('input');num.type='number';num.min='1';num.dataset.f='param';num.dataset.k=pk;num.value=r.params?.[pk]??'';num.disabled=!ahDom.canEdit
   pl.append(num,document.createTextNode(' '+unit+(r.kind==='fail_count'?` ใน ${r.params?.minutes??'—'} นาที`:'')))
   ctl.append(pl)
  }
  const ll=document.createElement('label');ll.className='ah-field';ll.append(document.createTextNode('ระดับ '))
  const sel=document.createElement('select');sel.dataset.f='level';sel.disabled=!ahDom.canEdit
  for(const [v,lab] of [['warn','ต้องดู'],['urgent','ด่วน']]){const o=document.createElement('option');o.value=v;o.textContent=lab;if(r.level===v)o.selected=true;sel.append(o)}
  ll.append(sel);ctl.append(ll)
  const nl=document.createElement('label');nl.className='ah-field'
  const nb=document.createElement('input');nb.type='checkbox';nb.dataset.f='notify';nb.checked=!!r.notify;nb.disabled=!ahDom.canEdit
  nl.append(nb,document.createTextNode(' แจ้ง Telegram'));ctl.append(nl)
  ctl.append(text('span',String(r.hour_from).padStart(2,'0')+':00–'+String(r.hour_to).padStart(2,'0')+':00','muted'))
  row.append(ctl);ahDom.rules.append(row)
 }
}
async function onAdminRuleChange(e){
 const el=e.target,rule=el.closest('.ah-rule')
 if(!rule||!ahDom||!ahDom.canEdit)return
 const body={id:rule.dataset.id}
 if(el.dataset.f==='enabled')body.enabled=el.checked
 else if(el.dataset.f==='notify')body.notify=el.checked
 else if(el.dataset.f==='level')body.level=el.value
 else if(el.dataset.f==='param'){
  const n=parseInt(el.value,10)
  if(!(n>=1)){ahError('ค่าต้องเป็นตัวเลขตั้งแต่ 1 ขึ้นไป');return}
  ahError('');body.params={[el.dataset.k]:n}
 }
 // กฎเปลี่ยนแล้วกระทบการเตือนบนระบบจริงทันที จึงถามยืนยันทุกครั้งก่อนบันทึก — กดไม่ตกลง = หน้าจอคืนค่าจากฐาน
 if(!confirm(`บันทึกการเปลี่ยนแปลงกฎ "${rule.dataset.name}" บนระบบจริงหรือไม่?`)){refreshAdminHealth().catch(()=>{});return}
 try{await ahFetch('/api/admin/health-rule',body);await refreshAdminHealth()}
 catch(err){ahError('บันทึกกฎไม่สำเร็จ: '+err.message);await refreshAdminHealth().catch(()=>{})}
}
async function runAdminSelfTest(){
 if(ahBusyTest)return;ahBusyTest=true
 const btn=ahDom.testBtn;btn.disabled=true;btn.textContent='กำลังตรวจ…'
 try{
  const data=await ahFetch('/api/admin/system-health/test',{})
  // contract เดิม: tests มาจาก flowHealth.selftest() ที่ backend — steps เป็น array เสมอ
  const steps=Array.isArray(data.tests)?data.tests:[]
  ahDom.steps.hidden=false;ahDom.steps.replaceChildren()
  for(const s of steps){
   const pass=s.result==='PASS',skip=!pass&&/ข้าม/.test(s.detail??'')
   const row=text('div','','ah-step')
   row.append(text('span',pass?'✅ ผ่าน':skip?'⚠️ ข้าม':'❌ ผิดพลาด','ah-step-icon '+(pass?'ah-ok':skip?'ah-skip':'ah-fail')))
   const name=text('span',s.name);if(!pass&&s.detail)name.title=s.detail
   row.append(name,text('span',(s.ms??0)+' ms','ah-ms'))
   ahDom.steps.append(row)
  }
  ahDom.steps.append(text('div',`ผ่าน ${data.passed??0}/${steps.length}`+(data.ok?' · ปกติทั้งหมด':' · มีข้อที่ต้องดู'),'ah-sum'))
  await refreshAdminHealth().catch(()=>{})
 }catch(err){ahError('ตรวจไม่สำเร็จ: '+err.message)}
 finally{ahBusyTest=false;btn.disabled=false;btn.textContent='ตรวจทุกขั้น'}
}
async function start(){boot=await api('bootstrap');$('login-panel').hidden=true;$('workspace').hidden=false;$('user').textContent=boot.user.email;$('stats-link').hidden=!['manager','admin'].includes(boot.user.role);relocateRefreshButton();wireAppNav(boot.user.role);
// หน้าสถานะระบบ: ยังใช้ header/nav/notice เดิมทุกอย่าง แค่สลับเนื้อหาตรงกลาง — ไม่โหลดของแชท
if(ANSWER_VIEW){const { mountAnswerHub } = await import('./answer-hub.js');return mountAnswerHub({ api, role: boot.user.role })}
if(ADMIN_VIEW){document.body.classList.add('admin-view');return initAdminHealth()}
const { mountQuickAnswer } = await import('./quick-answer.js');mountQuickAnswer({api,getContext:()=>({conversation_id:selected,project_id:detail?.conversation?.project_id??detail?.lead?.project_id??null})})
await refreshBot();renderChannels();$('project').replaceChildren();for(const p of boot.projects){const o=text('option',p.name);o.value=p.id;$('project').append(o)}filter=readFilter();writeFilter();renderFilters();await loadList();const match=/^\/conversations\/([^/]+)$/.exec(location.pathname);if(match){try{await selectCase(decodeURIComponent(match[1]))}catch(e){note('เปิดบทสนทนาไม่สำเร็จ: '+e.message,true)}}}
setInterval(async()=>{if(!boot||busy||polling||document.hidden||ADMIN_VIEW||ANSWER_VIEW)return;polling=true;const id=selected,seq=sequence;try{await refreshBot();await loadList();if(id){const next=await api('messages',{id});if(id!==selected||seq!==sequence||busy)return;const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<80;if(JSON.stringify(next.messages)!==JSON.stringify(detail.messages)){detail.messages=next.messages;renderMessages(next.messages);if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight}detail.conversation=next.conversation;renderDue(next.state||{},next.conversation.status==='resolved');detail.case_status=next.case_status;
 // ★ เตือนเมื่อ "คนอื่น" ตอบแทรกระหว่างที่เรากำลังพิมพ์ — คิวรวมแปลว่าสองคนหยิบเคสเดียวกันได้
 //   เตือนเฉพาะตอนที่ในช่องพิมพ์มีข้อความค้างอยู่ ไม่งั้นจะเด้งรบกวนทุกครั้งที่เพื่อนตอบ
 {const before=detail.last_agent_reply,after=next.last_agent_reply
  if(after&&after.at!==(before&&before.at)&&after.by!==boot?.user?.id&&$('message').value.trim())
    note((after.name||'เพื่อนร่วมทีม')+' เพิ่งตอบเคสนี้ไปเมื่อ '+date(after.at)+' ตรวจก่อนส่งซ้ำ',true)
  detail.last_agent_reply=after}
 const wait=sla(next.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;permissions()}}catch(e){note(e.message,true)}finally{polling=false}},10000)
window.addEventListener('beforeunload',e=>{if(dirty||$('message').value.trim()){e.preventDefault();e.returnValue=''}})
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('login-submit');btn.disabled=true;$('login-error').textContent='';try{await request('/api/login',{email:$('login-email').value,password:$('login-password').value});$('login-password').value='';// ★ ล็อกอินจากหน้าไหนกลับไปหน้านั้น — เข้า /admin/health ตอนยังไม่ล็อกอินจะได้ไม่ต้องพิมพ์ URL ซ้ำ
const back=safeReturnTo(new URLSearchParams(location.search).get('return_to'))||(/^\/conversations\/[^/]+$/.test(location.pathname)?currentReturnTo():null);location.replace(back||(ANSWER_VIEW?'/answer-hub':ADMIN_VIEW?'/admin/health':'/'))}catch(e){$('login-error').textContent=e.message}finally{btn.disabled=false}})
$('logout').addEventListener('click',async()=>{if((dirty||$('message').value.trim())&&!confirm('มีข้อความหรือข้อมูลที่ยังไม่ได้บันทึก ต้องการออกจากระบบหรือไม่?'))return;$('logout').disabled=true;try{await request('/api/logout',{});dirty=false;$('message').value='';location.replace('/')}catch(e){note(e.message,true);$('logout').disabled=false}})
start().catch(e=>{$('workspace').hidden=true;$('login-panel').hidden=false;if(e.code!=='session_expired')$('login-error').textContent=e.message})
