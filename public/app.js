const $ = id => document.getElementById(id)
const labels={mine:'งานของฉัน',unassigned:'ยังไม่มีคนรับ',waiting:'รอลูกค้าตอบ',sla:'ตอบเกิน SLA',today:'นัดหมายวันนี้',followup:'ถึงเวลาติดตาม',closed:'ปิดแล้ว',all:'ทั้งหมด'}
const channelState={ok:'รับข้อความอยู่',idle:'เงียบเกิน 24 ชั่วโมง',down:'มีปัญหา',off:'ยังไม่ได้เชื่อม',unknown:'ตรวจสถานะไม่ได้'}
const stageNames={follow_up:'ติดตาม',qualified:'Qualified',appointment:'นัดชม',walk_in:'Walk-in',booking:'Booking',sale:'Sale',lost:'ปิดแล้ว'}
const errors={invalid_credentials:'อีเมลหรือรหัสผ่านไม่ถูกต้อง',too_many_attempts:'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาที',not_allowed:'บัญชีของระบบไม่มีสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแล',session_expired:'เชื่อมต่อระบบหลังบ้านไม่ได้ กรุณารีเฟรชหน้า',channel_not_configured:'ยังไม่ได้เชื่อมบัญชีช่องทางนี้ กรุณาติดต่อผู้ดูแล',already_assigned:'มีผู้รับเคสนี้แล้ว กรุณารีเฟรช',claim_required:'กรุณารับเคสก่อนทำรายการ',version_conflict:'ข้อมูลถูกแก้ไขจากอีกหน้าจอ กรุณาเลือกเคสใหม่แล้วตรวจข้อมูล',stage_transition_not_allowed:'กรุณาดำเนินการตามลำดับสถานะ',future_appointment_required:'กรุณาเลือกวันเวลานัดในอนาคต',unit_unavailable:'ห้องนี้ไม่พร้อมจอง',booking_required:'ต้องมีใบจองก่อนบันทึก Sale',case_closed:'เคสนี้ปิดแล้ว',service_unavailable:'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่',request_rejected:'บันทึกไม่สำเร็จ กรุณาตรวจข้อมูลและลำดับสถานะ',invalid_origin:'กรุณาเปิดผ่าน URL ที่ผู้ดูแลกำหนด',shadow_mode:'ตอนนี้ระบบอยู่ในโหมดเก็บข้อมูล ยังไม่เปิดให้ส่งข้อความหาลูกค้า'}
let boot,items=[],selected=null,detail=null,filter='unassigned',offset=0,busy=false,dirty=false,sequence=0,listSequence=0,polling=false
const drafts=new Map(),pendingCommands=new Map()
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
async function loadList(){const seq=++listSequence;const data=await api('list',{filter,search:$('search').value.trim(),offset});if(seq!==listSequence)return;items=data.slice(0,50);$('next').disabled=data.length<=50;$('previous').disabled=offset===0;renderList();await refreshCounts()}
function renderList(){
  $('conversations').replaceChildren();
  for(const item of items){
    const closed=item.status==='resolved',s=sla(item),overdue=s.style==='critical';
    const b=text('button','','conversation-item'+(item.id===selected?' selected':'')+(overdue?' overdue':''));
    // ── บรรทัด 1: ชื่อ · สถานะ · แจ้งเตือน ····· เวลา · ช่องทาง ──
    const shown=customerName(item.display_name,item.external_id,item.channel);const row=text('div','','person-row'),name=text('strong',shown);row.append(avatar(item.picture_url,shown));
    if(overdue||item.unread_count>0){const dot=text('span','','unread-dot');dot.setAttribute('aria-hidden','true');name.prepend(dot);const hint=text('span',overdue?' · เกิน SLA': ' · ยังไม่ได้อ่าน','sr-only');name.append(hint)}
    row.append(name);
    // ★ สถานะมาจาก case_status ในฐานที่เดียว — ของเดิมคิดจาก waiting_since เองที่เบราว์เซอร์
    //   ซึ่งขัดกับคอมเมนต์เหนือ sla() ที่ว่า "หน้าจอไม่คิดเองอีกแล้ว" เลยตัดออก
    const label=closed?'ปิดแล้ว':s.label;
    if(label){
      const pill=text('span','','pill status '+statusTone(closed?'closed':item.case_status));
      // ★ แยก " N นาที" ออกเป็น span ของตัวเอง เพื่อให้ CSS ซ่อนจำนวนนาทีได้ตอนจอแคบ
      //   โดยไม่ต้องแก้ sla() ซึ่งหัวแชท (renderDetail) ใช้ร่วมอยู่และต้องเห็นนาทีเสมอ
      const m=/^(.*?)(\s\d+\s*นาที)$/.exec(label);
      if(m){pill.textContent=m[1];pill.append(text('span',m[2],'pill-n'))}
      else pill.textContent=label;
      row.append(pill)
    }
    // ★ แจ้งเตือนรวมเป็นใบเดียวเสมอ ถึงจะมีสองเรื่องก็ต่อท้ายเป็น "+1"
    //   สองใบทำให้การ์ดล้นขอบที่ความกว้างพาเนล 245px (app.css:288 จอ <=1050px)
    //   และใบที่สองมีค่าน้อยกว่าชื่อลูกค้าที่ถูกเบียดหายไปแลกมา
    const alerts=dueAlerts(item,closed);
    if(alerts.length){
      const short=ALERT_SHORT[alerts[0]]||alerts[0];
      row.append(text('span',alerts.length>1?short+' +'+(alerts.length-1):short,'pill status crit alert'));
      // ★ ข้อความเต็มต้องไม่ผูกกับ pill ใบนั้น เพราะ pill ถูกซ่อนตอนจอแคบ
      //   ถ้าเอา sr-only ไปแปะไว้ข้างใน คนใช้โปรแกรมอ่านหน้าจอจะไม่ได้ยินเลยบนโน้ตบุ๊ก
      row.append(text('span',' ('+alerts.join(' · ')+')','sr-only'));
      b.title=alerts.join(' · ')
    }
    // ★ ช่อง .conv-time ใส่เสมอแม้ไม่มีเวลา เพราะมันคือตัว ml-auto ที่ดันช่องทางไปชิดขวา
    //   ถ้าไม่ใส่ตอนไม่มีเวลา badge จะเลื่อนมาติดชื่อ การ์ดในรายการเดียวกันจะเรียงไม่ตรงกัน
    const stamp=listTime(item.last_message_at),when=text('span',stamp,'conv-time');
    if(stamp)when.title=date(item.last_message_at);
    row.append(when,text('span',item.channel==='line'?'LINE':'FB','pill channel '+(item.channel==='line'?'line':'fb')));
    // ── บรรทัด 2: ข้อความล่าสุด บรรทัดเดียว ตัดด้วย … ──
    b.append(row,text('p',item.last_message_preview||'ยังไม่มีข้อความ'));
    b.addEventListener('click',()=>selectCase(item.id).catch(e=>note(e.message,true)));$('conversations').append(b)
  }
  if(!items.length)$('conversations').append(text('p','ไม่พบเคสในรายการนี้','muted'))
}
function renderMessages(messages,prepend=false){if(!prepend)$('messages').replaceChildren();const fragment=document.createDocumentFragment();for(const m of messages){const b=text('div',m.content,'bubble'+(m.sender_type==='agent'?' out':m.sender_type==='bot'?' bot':''));const status=m.sender_type==='agent'?({pending:'รอส่ง',processing:'กำลังส่ง',sent:'ส่งสำเร็จ',failed:'ส่งไม่สำเร็จ',uncertain:'ยังยืนยันการส่งไม่ได้'}[m.delivery_status]||'บันทึกแล้ว'):m.sender_type==='bot'?'Bot':'';b.append(text('small',date(m.created_at)+(status?' · '+status:''),m.delivery_status==='failed'?'delivery-error':''));if(m.delivery_status==='failed'){const retry=text('button','ลองส่งอีกครั้ง');retry.addEventListener('click',()=>mutate('retry',{message_id:m.id}));b.append(retry)}fragment.append(b)}if(prepend)$('messages').prepend(fragment);else $('messages').append(fragment);$('older').hidden=messages.length<100}
async function selectCase(id){if(busy)return;if(dirty&&!confirm('มีข้อมูลที่ยังไม่ได้บันทึก ต้องการเปลี่ยนเคสหรือไม่?'))return;if(selected)drafts.set(selected,$('message').value);const seq=++sequence;const data=await api('detail',{id});if(seq!==sequence)return;selected=id;detail=data;items=items.map(item=>item.id===id?{...item,unread_count:0}:item);dirty=false;$('empty').hidden=true;$('chat').hidden=false;setChatOpen(true);$('lead-empty').hidden=true;$('lead-details').hidden=false;renderDetail();renderList();$('messages').scrollTop=$('messages').scrollHeight}
function renderDetail(){const c=detail.conversation,l=detail.lead||{},s=detail.state||{};const who=customerName(detail.contact.display_name,detail.contact.external_id,detail.channel);$('chat-name').textContent=who;renderContactId(detail.contact.external_id);$('chat-channel').textContent=detail.channel==='line'?'LINE Official Account':'Facebook Messenger';const wait=sla(detail.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;$('display-name').value=detail.contact.display_name||'';$('phone').value=detail.contact.phone||'';$('budget').value=l.budget??'';$('room').value=l.interest_unit_type||'';$('interest').value=l.extra?.interest||'unknown';$('project').value=l.project_id||boot.projects[0]?.id||'';$('followup').value=local(s.follow_up_at);$('owner').textContent=boot.assignees.find(a=>a.id===c.assignee_id)?.name||'ยังไม่มีคนรับ';$('appointment-summary').textContent=s.appointment_at?date(s.appointment_at):'ยังไม่มีนัดหมาย';renderDue(s,c.status==='resolved');$('message').value=drafts.get(selected)||'';renderMessages(detail.messages);$('pipeline').replaceChildren();for(const [code,label]of Object.entries(stageNames)){if(code==='lost')continue;const b=text('button',label,l.stage_code===code?'active':'');b.addEventListener('click',()=>stage(code));$('pipeline').append(b)}$('canned').replaceChildren();for(const item of rankTemplates(boot.canned.filter(x=>x.project_id===$('project').value))){const b=text('button',item.shortcut);b.type='button';b.title=item.content;b.addEventListener('click',()=>useTemplate(item.content));$('canned').append(b)}permissions()}
async function mutate(action,data={}){if(busy||!selected)return;const id=selected;const key=JSON.stringify({id,action,data});const requestId=pendingCommands.get(key)||crypto.randomUUID();pendingCommands.set(key,requestId);setBusy(true);try{const result=await api(action,{...data,id,request_id:requestId});pendingCommands.delete(key);if(action==='send'){drafts.delete(id);$('message').value=''}$('dialog').close();dirty=false;detail=await api('detail',{id});renderDetail();await loadList();note(action==='send'?'ข้อความเข้าคิวแล้ว สถานะส่งจะแสดงใต้ข้อความ':result.booking_id?'บันทึกเอกสารจองและข้อมูล ERP แล้ว':'บันทึกข้อมูลแล้ว')}catch(e){if(e.code&&e.code!=='service_unavailable')pendingCommands.delete(key);note(e.message,true);$('dialog-error').textContent=e.message}finally{setBusy(false)}}
let dialogAction,dialogData
function dialog(title,fields,action,extra={}){dialogAction=action;dialogData=extra;$('dialog-title').textContent=title;$('dialog-fields').replaceChildren();$('dialog-error').textContent='';for(const f of fields){const label=text('label',f.label);const input=document.createElement(f.options?'select':'input');input.name=f.name;input.required=f.required!==false;if(f.options){for(const o of f.options){const option=text('option',o.label);option.value=o.value;input.append(option)}}else{input.type=f.type||'text';if(f.min!==undefined)input.min=f.min;if(f.step)input.step=f.step;if(f.value!==undefined)input.value=f.value;if(f.maxLength)input.maxLength=f.maxLength}label.append(input);$('dialog-fields').append(label)}$('dialog').showModal()}
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
const shortLabels={unassigned:'รอรับ',sla:'SLA',followup:'ติดตาม',mine:'ของฉัน',waiting:'รอลูกค้า',today:'นัดวันนี้',closed:'ปิดแล้ว',all:'ทั้งหมด'}
const primaryFilters=['all','unassigned','sla','followup','mine']
const moreFilters=['waiting','today','closed']
// ชื่อใน URL สั้นกว่าคีย์ภายใน — อ่านออกแล้วเข้าใจได้เลยว่าหน้าไหน
// รับคีย์ภายในด้วย ไม่งั้น waiting/today/closed จะหายทุกครั้งที่รีเฟรช
const urlNames={all:'all',unassigned:'pending',sla:'sla',followup:'follow',mine:'mine'}
const fromUrl=Object.fromEntries(Object.entries(urlNames).map(([k,v])=>[v,k]))
const readFilter=()=>{const v=new URL(location.href).searchParams.get('filter')||''
 return fromUrl[v]||(labels[v]?v:'all')}
function writeFilter(){const u=new URL(location.href)
 u.searchParams.set('filter',urlNames[filter]||filter)
 history.replaceState(null,'',u)}
let counts={},closeMenu=null

const svg=(tag,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}
function moreIcon(){
 const s=svg('svg',{viewBox:'0 0 16 16','aria-hidden':'true',focusable:'false',class:'chip-icon'})
 for(const [y,cx] of [[4,10],[8,6],[12,11]]){
  s.append(svg('line',{x1:2,y1:y,x2:14,y2:y,stroke:'currentColor','stroke-width':1.4,'stroke-linecap':'round'}))
  s.append(svg('circle',{cx,cy:y,r:1.9,fill:'currentColor'}))
 }
 return s
}

// กดชิปที่เลือกอยู่ซ้ำ = ถอดตัวกรอง กลับไปทั้งหมด
// เป็นทางออกที่หาเจอเอง ไม่ต้องรู้ว่าต้องไปกดชิปไหนเพื่อเลิกกรอง
function pickFilter(key){const next=filter===key?'all':key
 if(filter===next&&key!=='all')return
 filter=next;offset=0;writeFilter();renderFilters();loadList().catch(e=>note(e.message,true))}

// ★ สีแดงใช้เฉพาะตอนมีของค้างจริง (count>0) — เป็น 0 เมื่อไหร่ต้องกลับเป็นชิปเทาธรรมดา
//   ไม่งั้นแถบนี้จะแดงตลอดเวลาจนคนเลิกมอง ซึ่งแย่กว่าไม่มีสีเตือนเลย
function chipFor(key){
 const n=counts[key]??0,on=filter===key
 const b=text('button','','chip'+(on?' selected':'')+(n>0&&key==='unassigned'?' hot-alert':'')+(n>0&&key==='sla'?' hot-sla':''))
 b.type='button';b.title=labels[key]
 b.setAttribute('aria-pressed',String(on))
 b.setAttribute('aria-label',labels[key]+(n>0?' '+n+' เคส':''))
 if(key==='unassigned'&&n>0){const d=text('span','','chip-dot');d.setAttribute('aria-hidden','true');b.append(d)}
 b.append(text('span',shortLabels[key],'chip-name'))
 if(n>0)b.append(text('span',String(n),'chip-n'))
 b.addEventListener('click',()=>pickFilter(key))
 return b
}

function renderFilters(){
 const nav=$('filters');if(!nav)return
 if(closeMenu)closeMenu()
 nav.replaceChildren()
 for(const key of primaryFilters)nav.append(chipFor(key))

 const wrap=$('filter-more');if(!wrap)return
 wrap.replaceChildren()
 const inMenu=moreFilters.includes(filter)
 const btn=text('button','','chip chip-more-btn'+(inMenu?' selected':''))
 btn.type='button';btn.title='ตัวกรองเพิ่มเติม'
 btn.setAttribute('aria-label','ตัวกรองเพิ่มเติม')
 btn.setAttribute('aria-haspopup','true');btn.setAttribute('aria-expanded','false')
 btn.append(moreIcon())

 const menu=text('div','','chip-menu');menu.hidden=true
 for(const key of moreFilters){
  const n=counts[key]??0
  const item=text('button','','chip-menu-item'+(filter===key?' selected':''))
  item.type='button'
  item.append(text('span',labels[key],'chip-menu-name'))
  if(n>0)item.append(text('span',String(n),'chip-n'))
  item.addEventListener('click',()=>{close();pickFilter(key)})
  menu.append(item)
 }

 // ปิดเมนูเมื่อคลิกข้างนอกหรือกด Esc — ถ้าไม่ถอด listener ตอนปิด
 // ทุกครั้งที่ render ใหม่จะทิ้ง listener ค้างไว้ แล้วสะสมไปเรื่อย ๆ
 function onDocClick(e){if(!wrap.contains(e.target))close()}
 function onKey(e){if(e.key==='Escape'){close();btn.focus()}}
 function close(){
  if(menu.hidden)return
  menu.hidden=true;btn.setAttribute('aria-expanded','false')
  document.removeEventListener('click',onDocClick,true)
  document.removeEventListener('keydown',onKey)
  closeMenu=null
 }
 function open(){
  menu.hidden=false;btn.setAttribute('aria-expanded','true')
  document.addEventListener('click',onDocClick,true)
  document.addEventListener('keydown',onKey)
  closeMenu=close
 }
 btn.addEventListener('click',e=>{e.stopPropagation();menu.hidden?open():close()})

 wrap.append(btn,menu)
}

// นับทุกตัวกรองในคำขอเดียว แล้ววาดชิปใหม่
// นับไม่ได้ไม่ใช่เหตุให้หน้าจอพัง — ชิปยังกดได้ แค่ไม่มีตัวเลข
async function refreshCounts(){
 try{counts=await api('queue_counts',{search:$('search').value.trim()})}
 catch{counts={}}
 renderFilters()
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
function setChatOpen(on){ document.body.classList.toggle('chat-open', on && MOBILE.matches) }
$('back').addEventListener('click',()=>{ setChatOpen(false); $('conversations').scrollIntoView({block:'start'}) })
// หมุนจอกลางคัน: ถ้ากว้างเกินเกณฑ์แล้วต้องคืนสภาพเอง ไม่งั้นค้างเป็นแชทเต็มจอบนจอคอม
MOBILE.addEventListener('change',e=>{ if(!e.matches) document.body.classList.remove('chat-open','kb-open') })

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

async function start(){boot=await api('bootstrap');$('login-panel').hidden=true;$('workspace').hidden=false;await refreshBot();$('user').textContent=boot.user.email;$('stats-link').hidden=!['manager','admin'].includes(boot.user.role);renderChannels();$('project').replaceChildren();for(const p of boot.projects){const o=text('option',p.name);o.value=p.id;$('project').append(o)}filter=readFilter();writeFilter();renderFilters();await loadList()}
setInterval(async()=>{if(!boot||busy||polling||document.hidden)return;polling=true;const id=selected,seq=sequence;try{await refreshBot();await loadList();if(id){const next=await api('messages',{id});if(id!==selected||seq!==sequence||busy)return;const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<80;if(JSON.stringify(next.messages)!==JSON.stringify(detail.messages)){detail.messages=next.messages;renderMessages(next.messages);if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight}detail.conversation=next.conversation;renderDue(next.state||{},next.conversation.status==='resolved');detail.case_status=next.case_status;
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