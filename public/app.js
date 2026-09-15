const $ = id => document.getElementById(id)
const labels={mine:'งานของฉัน',unassigned:'ยังไม่มีคนรับ',waiting:'รอลูกค้าตอบ',sla:'ตอบเกิน SLA',today:'นัดหมายวันนี้',followup:'ถึงเวลาติดตาม',closed:'ปิดแล้ว',all:'ทั้งหมด'}
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

function dueAlerts(state,closed=false){if(closed)return [];const now=Date.now();return [['appointment_at','ถึงเวลานัดหมาย'],['follow_up_at','ติดตามเลยกำหนด']].filter(([key])=>state[key]&&Date.parse(state[key])<=now).map(([,label])=>label)}
function renderDue(state,closed){let box=$('due-alerts');if(!box){box=text('div','','case-alerts');box.id='due-alerts';$('appointment-summary').after(box)}box.replaceChildren(...dueAlerts(state,closed).map(label=>text('span',label,'pill red')))}
let countSequence=0;
async function refreshSlaCount(){const seq=++countSequence,ids=new Set();let pageOffset=0;try{while(true){const page=await api('list',{filter:'sla',search:'',offset:pageOffset});if(seq!==countSequence||!boot)return;for(const item of page.slice(0,50))ids.add(item.id);if(page.length<=50)break;pageOffset+=50;if(pageOffset>100000)throw Error("count_limit")}const badge=$('sla-count');if(badge){badge.textContent=String(ids.size);badge.hidden=ids.size===0;badge.parentElement.setAttribute('aria-label',labels.sla+' '+ids.size+' เคส')}}catch{if(seq!==countSequence)return;const badge=$('sla-count');if(badge){badge.hidden=true;badge.parentElement.setAttribute('aria-label',labels.sla+' · โหลดจำนวนไม่สำเร็จ')}}}

function setBusy(value){busy=value;for(const id of ['claim','send','save','transfer','appointment','close','dialog-submit'])$(id).disabled=value;for(const b of $('pipeline').querySelectorAll('button'))b.disabled=value;if(!value&&detail)permissions()}
function permissions(){const c=detail.conversation,canEdit=c.status!=='resolved'&&(c.assignee_id===boot.user.id||['manager','admin'].includes(boot.user.role)&&c.assignee_id);$('claim').hidden=!!c.assignee_id||c.status==='resolved';$('transfer').hidden=!['manager','admin','senior_sales'].includes(boot.user.role)||!c.assignee_id||c.status==='resolved';for(const id of ['send','message','save','appointment','close'])$(id).disabled=busy||!canEdit;for(const b of $('pipeline').querySelectorAll('button'))b.disabled=busy||!canEdit;$('send-hint').textContent=canEdit?'ตรวจข้อความก่อนกดส่ง':'รับเคสก่อนตอบและบันทึกข้อมูล'}
async function loadList(){const seq=++listSequence;const data=await api('list',{filter,search:$('search').value.trim(),offset});if(seq!==listSequence)return;items=data.slice(0,50);$('next').disabled=data.length<=50;$('previous').disabled=offset===0;renderList();await refreshSlaCount()}
function renderList(){
  $('conversations').replaceChildren();$('queue-label').textContent=labels[filter];$('list-count').textContent=items.length+' เคส';
  for(const item of items){
    const closed=item.status==='resolved',s=sla(item),overdue=s.style==='critical';
    const b=text('button','','conversation-item'+(item.id===selected?' selected':'')+(overdue?' overdue':''));
    const row=text('div','','person-row'),name=text('strong',item.display_name||'ลูกค้าใหม่');
    if(overdue||item.unread_count>0){const dot=text('span','','unread-dot');dot.setAttribute('aria-hidden','true');name.prepend(dot);const hint=text('span',overdue?' · เกิน SLA': ' · ยังไม่ได้อ่าน','sr-only');name.append(hint)}
    row.append(name,text('span',item.channel==='line'?'LINE':'FB','pill'));
    const label=closed?'ปิดแล้ว':!item.waiting_since?'รอลูกค้าตอบ':s.label;
    b.append(row,text('p',item.last_message_preview||'ยังไม่มีข้อความ'),text('span',label,'pill '+(!closed&&!item.waiting_since?'yellow':s.style)));
    const alerts=dueAlerts(item,closed);if(alerts.length){const box=text('div','','case-alerts');box.append(...alerts.map(label=>text('span',label,'pill red')));b.append(box)}
    b.addEventListener('click',()=>selectCase(item.id).catch(e=>note(e.message,true)));$('conversations').append(b)
  }
  if(!items.length)$('conversations').append(text('p','ไม่พบเคสในรายการนี้','muted'))
}
function renderMessages(messages,prepend=false){if(!prepend)$('messages').replaceChildren();const fragment=document.createDocumentFragment();for(const m of messages){const b=text('div',m.content,'bubble'+(m.sender_type==='agent'?' out':''));const status=m.sender_type==='agent'?({pending:'รอส่ง',processing:'กำลังส่ง',sent:'ส่งสำเร็จ',failed:'ส่งไม่สำเร็จ',uncertain:'ยังยืนยันการส่งไม่ได้'}[m.delivery_status]||'บันทึกแล้ว'):m.sender_type==='bot'?'Bot':'';b.append(text('small',date(m.created_at)+(status?' · '+status:''),m.delivery_status==='failed'?'delivery-error':''));if(m.delivery_status==='failed'){const retry=text('button','ลองส่งอีกครั้ง');retry.addEventListener('click',()=>mutate('retry',{message_id:m.id}));b.append(retry)}fragment.append(b)}if(prepend)$('messages').prepend(fragment);else $('messages').append(fragment);$('older').hidden=messages.length<100}
async function selectCase(id){if(busy)return;if(dirty&&!confirm('มีข้อมูลที่ยังไม่ได้บันทึก ต้องการเปลี่ยนเคสหรือไม่?'))return;if(selected)drafts.set(selected,$('message').value);const seq=++sequence;const data=await api('detail',{id});if(seq!==sequence)return;selected=id;detail=data;items=items.map(item=>item.id===id?{...item,unread_count:0}:item);dirty=false;$('empty').hidden=true;$('chat').hidden=false;$('lead-empty').hidden=true;$('lead-details').hidden=false;renderDetail();renderList();$('messages').scrollTop=$('messages').scrollHeight}
function renderDetail(){const c=detail.conversation,l=detail.lead||{},s=detail.state||{};$('chat-name').textContent=detail.contact.display_name||'ลูกค้าใหม่';$('chat-channel').textContent=detail.channel==='line'?'LINE Official Account':'Facebook Messenger';const wait=sla(detail.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;$('display-name').value=detail.contact.display_name||'';$('phone').value=detail.contact.phone||'';$('budget').value=l.budget??'';$('room').value=l.interest_unit_type||'';$('interest').value=l.extra?.interest||'unknown';$('project').value=l.project_id||boot.projects[0]?.id||'';$('followup').value=local(s.follow_up_at);$('owner').textContent=boot.assignees.find(a=>a.id===c.assignee_id)?.name||'ยังไม่มีคนรับ';$('appointment-summary').textContent=s.appointment_at?date(s.appointment_at):'ยังไม่มีนัดหมาย';renderDue(s,c.status==='resolved');$('message').value=drafts.get(selected)||'';renderMessages(detail.messages);$('pipeline').replaceChildren();for(const [code,label]of Object.entries(stageNames)){if(code==='lost')continue;const b=text('button',label,l.stage_code===code?'active':'');b.addEventListener('click',()=>stage(code));$('pipeline').append(b)}$('canned').replaceChildren();for(const item of boot.canned.filter(x=>x.project_id===$('project').value)){const b=text('button',item.shortcut);b.type='button';b.addEventListener('click',()=>{$('message').value=item.content;$('message').focus()});$('canned').append(b)}permissions()}
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
function shortChannel(c){
 const n=c.name||''
 if(/dev/i.test(n))return 'LINE Dev'
 if(/naii/i.test(n))return 'Naii OA'
 if(c.channel==='messenger')return 'Messenger'
 if(c.channel==='line')return 'LINE'
 return n.slice(0,12)
}
function renderChannels(){
 const box=$('channel-status');if(!box)return
 box.replaceChildren()
 if(!boot.channels.length){box.append(text('span','ยังไม่ได้เชื่อมช่องทางแชท','channel-chip off'));return}
 for(const c of boot.channels){
  const chip=text('span','','channel-chip '+(c.enabled?'on':'off'))
  const dot=text('span','','dot');dot.setAttribute('aria-hidden','true')
  chip.append(dot,text('span',shortChannel(c),'label'))
  chip.title=c.name+' · '+(c.enabled?'เชื่อมแล้ว':'ยังไม่เชื่อม')
  chip.setAttribute('aria-label',chip.title)
  box.append(chip)
 }
}
async function start(){boot=await api('bootstrap');$('login-panel').hidden=true;$('workspace').hidden=false;await refreshBot();$('user').textContent=boot.user.email;renderChannels();$('project').replaceChildren();for(const p of boot.projects){const o=text('option',p.name);o.value=p.id;$('project').append(o)}$('filters').replaceChildren();for(const [key,label]of Object.entries(labels)){const b=text('button',label,key===filter?'active':'');if(key==='sla'){const badge=text('span','','sla-count');badge.id='sla-count';badge.hidden=true;b.append(badge)}b.addEventListener('click',()=>{filter=key;offset=0;for(const x of $('filters').children)x.classList.toggle('active',x===b);loadList().catch(e=>note(e.message,true))});$('filters').append(b)}await loadList()}
setInterval(async()=>{if(!boot||busy||polling||document.hidden)return;polling=true;const id=selected,seq=sequence;try{await refreshBot();await loadList();if(id){const next=await api('messages',{id});if(id!==selected||seq!==sequence||busy)return;const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<80;if(JSON.stringify(next.messages)!==JSON.stringify(detail.messages)){detail.messages=next.messages;renderMessages(next.messages);if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight}detail.conversation=next.conversation;renderDue(next.state||{},next.conversation.status==='resolved');detail.case_status=next.case_status;const wait=sla(next.case_status);$('sla').textContent=wait.label;$('sla').className='pill '+wait.style;permissions()}}catch(e){note(e.message,true)}finally{polling=false}},10000)
window.addEventListener('beforeunload',e=>{if(dirty||$('message').value.trim()){e.preventDefault();e.returnValue=''}})
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('login-submit');btn.disabled=true;$('login-error').textContent='';try{await request('/api/login',{email:$('login-email').value,password:$('login-password').value});$('login-password').value='';location.replace('/')}catch(e){$('login-error').textContent=e.message}finally{btn.disabled=false}})
$('logout').addEventListener('click',async()=>{if((dirty||$('message').value.trim())&&!confirm('มีข้อความหรือข้อมูลที่ยังไม่ได้บันทึก ต้องการออกจากระบบหรือไม่?'))return;$('logout').disabled=true;try{await request('/api/logout',{});dirty=false;$('message').value='';location.replace('/')}catch(e){note(e.message,true);$('logout').disabled=false}})
start().catch(e=>{$('workspace').hidden=true;$('login-panel').hidden=false;if(e.code!=='session_expired')$('login-error').textContent=e.message})