// Phase 9 editor, mounted inside the existing authenticated application shell.
const el = (tag, value = '') => { const n = document.createElement(tag); n.textContent = value; return n }
const lines = value => value.split('\n').map(x => x.trim()).filter(Boolean)
const messages = { HUB_DISABLED: 'คลังคำตอบยังปิดอยู่', FEATURE_DISABLED: 'การอ่านข้อมูล ERP ยังปิดอยู่', ANSWER_NOT_ALLOWED: 'ไม่มีสิทธิ์ทำรายการนี้', ANSWER_DUPLICATE: 'รหัสคำตอบหรือตัวแปรซ้ำ', ANSWER_INVALID: 'กรุณาตรวจข้อมูลในฟอร์ม', ANSWER_NOT_FOUND: 'ไม่พบรายการ', INTERNAL_ERROR: 'ระบบไม่พร้อม กรุณาลองใหม่' }

export async function mountAnswerHub({ api, role }) {
  const css = el('link'); css.rel = 'stylesheet'; css.href = '/answer-hub.css'; document.head.append(css)
  document.body.classList.add('answer-view')
  const root = el('section'); root.id = 'answer-editor'
  document.querySelector('#workspace main').append(root)
  root.append(el('h1', 'คลังคำตอบ'))
  const notice = el('p', 'กำลังโหลด…'); notice.setAttribute('role', 'status'); root.append(notice)
  if (!['admin', 'manager'].includes(role)) { notice.textContent = 'หน้านี้สำหรับ manager และ admin'; return }
  const call = async (action, data = {}) => {
    const result = await api(action, data)
    if (!result.ok) throw Error(messages[result.code] ?? result.code ?? 'โหลดไม่สำเร็จ')
    return result.data ?? result
  }
  let options
  try { options = await call('ah_editor_options') } catch (e) { notice.textContent = e.message; return }
  let current = null, dirty = false, busy = false, page = 1
  const fields = {}, bindingRows = []
  const controls = el('fieldset'), toolbar = el('div'), list = el('div'), form = el('form')
  const preview = el('pre'), history = el('div'), bindings = el('div'), status = el('p')
  root.append(controls); controls.append(toolbar, list, form)
  const dashboard = el('section'); dashboard.id = 'answer-dashboard'; controls.append(dashboard)
  dashboard.append(el('h2', 'Answer Hub dashboard'))
  const dashboardSummary = el('pre'); dashboard.append(dashboardSummary)
  const refreshDashboard = async () => { const summary = await call('ah_health'); dashboardSummary.textContent = Object.entries(summary).filter(([key]) => key !== 'checked_at').map(([key, value]) => `${key}: ${value}`).join('\n') }
  button('Refresh dashboard', refreshDashboard, dashboard)
  await refreshDashboard().catch(e => { dashboardSummary.textContent = e.message })
  const importBox = el('section'); importBox.id = 'answer-import'; controls.append(importBox)
  const setNotice = value => { notice.textContent = value }
  const run = async fn => {
    if (busy) return
    busy = true; controls.inert = true; root.setAttribute('aria-busy', 'true')
    try { await fn() } catch (e) { setNotice(e.message) }
    finally { busy = false; controls.inert = false; root.setAttribute('aria-busy', 'false') }
  }
  const button = (label, fn, parent = toolbar) => {
    const b = el('button', label); b.type = 'button'; b.onclick = () => run(fn); parent.append(b); return b
  }
  // Learning candidates are review-only.  This panel never writes directly:
  // every decision travels through ah_learning_review and its SQL role gate.
  if (role === 'manager' || role === 'admin') {
    const learningBox = el('section'); learningBox.id = 'learning-queue'; controls.append(learningBox)
    learningBox.append(el('h2', 'Learning Queue'))
    const learningRows = el('div'); learningBox.append(learningRows)
    const loadLearning = async () => {
      const r = await call('ah_learning_list', { status: 'pending' })
      learningRows.replaceChildren()
      if (!r.rows?.length) learningRows.append(el('p', 'No pending learning candidates'))
      for (const candidate of r.rows ?? []) {
        const row = el('article'); row.append(el('p', `Question: ${candidate.question}`), el('pre', candidate.human_answer))
        button('Approve to review', async () => {
          await call('ah_learning_review', { id: candidate.id, decision: 'approve', answer: {} })
          setNotice('Learning candidate created an answer in review'); await loadLearning(); await loadList()
        }, row)
        button('Edit then approve', async () => {
          const body = prompt('Answer text', candidate.human_answer)
          if (body === null) return
          await call('ah_learning_review', { id: candidate.id, decision: 'edit_approve', answer: { title: candidate.question, body_template: body } })
          setNotice('Edited learning candidate created an answer in review'); await loadLearning(); await loadList()
        }, row)
        button('Merge into open answer', async () => {
          if (!current?.id) throw Error('Open the target answer before merging')
          await call('ah_learning_review', { id: candidate.id, decision: 'merge', answer_id: current.id })
          setNotice('Learning question merged into the open answer for review'); await loadLearning(); await open(current.id); await loadList()
        }, row)
        button('Reject', async () => {
          await call('ah_learning_review', { id: candidate.id, decision: 'reject' })
          setNotice('Learning candidate rejected'); await loadLearning()
        }, row)
        learningRows.append(row)
      }
    }
    button('Refresh learning queue', loadLearning, learningBox)
  }
  const field = (name, label, type = 'text', choices = null, parent = form) => {
    const wrap = el('label', label), n = el(choices ? 'select' : type === 'textarea' ? 'textarea' : 'input')
    n.name = name; n.id = `ae-${name}`
    if (choices) for (const [value, title] of choices) { const o = el('option', title); o.value = value; n.append(o) }
    else if (type !== 'textarea') n.type = type
    wrap.append(n); parent.append(wrap); return n
  }
  const search = field('search', 'ค้นหาชื่อ / ข้อความ', 'search', null, toolbar)
  const filter = field('filter', 'สถานะ', 'text', ['', 'draft', 'review', 'approved', 'retired'].map(x => [x, x || 'ทั้งหมด']), toolbar)
  button('ค้นหา', async () => { page = 1; await loadList() })
  button('เพิ่มคำตอบ', () => { if (canLeave()) fill() })
  if (role === 'admin') {
    importBox.append(el('h2', 'Import Answers'))
    const template = button('Download template', () => {
      const csv = 'category,intent,title,question,answer,project,answer_type,audience,show_in_quick_answer,bot_auto_answer,priority,valid_from,valid_to\nprice_promo,ask_price,Example question,ราคาเท่าไร,Answer text,,static,both,true,false,100,,'
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'answer-hub-import-template.csv'; a.click(); URL.revokeObjectURL(a.href)
    }, importBox)
    const upload = document.createElement('input'); upload.type = 'file'; upload.accept = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; upload.id = 'ai-file'; importBox.append(upload)
    const summary = el('pre'); importBox.append(summary)
    let importRows = null
    button('Preview import', async () => {
      const file = upload.files?.[0]; if (!file) throw Error('เลือกไฟล์ CSV หรือ XLSX ก่อน')
      const content = /\.xlsx$/i.test(file.name) ? btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer()))) : await file.text()
      const r = await call('ah_import_preview', { filename: file.name, content })
      importRows = r.rows; summary.textContent = `NEW: ${r.new}\nUPDATE: ${r.update}\n\n` + r.rows.map(x => `row ${x._row}: ${x.classification} — ${x.title}`).join('\n')
      setNotice('Preview เสร็จแล้ว ยังไม่มีการบันทึกข้อมูล')
    }, importBox)
    button('Apply import', async () => {
      if (!importRows?.length) throw Error('ต้อง Preview ที่ผ่านก่อน Apply')
      const r = await call('ah_import_commit', { rows: importRows })
      summary.textContent = `Imported ${r.count} rows\nBatch: ${r.batch_id}\n` + JSON.stringify(r.rows, null, 2)
      await loadList(); setNotice('Import สำเร็จ และบันทึก audit batch แล้ว')
    }, importBox)
  }
  button('ก่อนหน้า', async () => { page = Math.max(1, page - 1); await loadList() })
  const next = button('ถัดไป', async () => { page++; await loadList() })
  form.append(el('h2', 'เพิ่ม / แก้ไขคำตอบ'), status)
  const configs = [
    ['answer_key', 'รหัสคำตอบ'], ['title', 'ชื่อคำตอบ'],
    ['category_id', 'หมวด', 'text', options.categories], ['intent_id', 'Intent', 'text', options.intents], ['project_id', 'โครงการ', 'text', options.projects],
    ['language', 'ภาษา'], ['question_examples', 'คำถามตัวอย่าง (หนึ่งบรรทัดต่อคำถาม)', 'textarea'], ['body_template', 'ข้อความ / Template {{variable}}', 'textarea'],
    ['answer_type', 'ชนิดคำตอบ', 'text', ['static', 'dynamic', 'hybrid']], ['audience', 'ผู้ใช้คำตอบ', 'text', ['human', 'bot', 'both']],
    ['source_type', 'ที่มา', 'text', ['manual', 'learned', 'imported', 'generated']], ['source_reference', 'อ้างอิงแหล่งข้อมูล'],
    ['attachments', 'ไฟล์แนบ (URL https หนึ่งบรรทัดต่อไฟล์)', 'textarea'],
    ['show_in_quick_answer', 'แสดงใน Quick Answer', 'checkbox'], ['bot_auto_answer', 'อนุญาตให้บอทตอบเอง', 'checkbox'],
    ['priority', 'ลำดับความสำคัญ', 'number'], ['confidence', 'ความมั่นใจ 0–1', 'number'],
    ['valid_from', 'เริ่มใช้ (เวลาท้องถิ่น)', 'datetime-local'], ['valid_to', 'สิ้นสุด (เวลาท้องถิ่น)', 'datetime-local'], ['change_reason', 'เหตุผลที่แก้ไข'],
  ]
  for (const [name, label, type, choices] of configs) {
    const mapped = choices ? (typeof choices[0] === 'string' ? choices.map(x => [x, x]) : [['', 'ไม่ระบุ / ทุกโครงการ'], ...choices.map(x => [x.id, x.name])]) : null
    fields[name] = field(name, label, type, mapped)
  }
  fields.title.required = fields.body_template.required = true
  fields.answer_key.pattern = '[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}'
  fields.confidence.min = '0'; fields.confidence.max = '1'; fields.confidence.step = '0.001'
  form.append(el('h3', 'ผูกตัวแปรกับข้อมูล ERP'), bindings)
  const bindingActions = el('div'); form.append(bindingActions)
  button('เพิ่มตัวแปร', () => { addBinding(); dirty = true }, bindingActions)
  const sourceInfo = el('details'); sourceInfo.append(el('summary', 'แหล่งข้อมูลที่มี'))
  for (const s of options.sources ?? []) sourceInfo.append(el('p', `${s.source_code}: ${s.active ? 'เปิด' : 'ปิด'} · ${s.description ?? s.name ?? ''}`))
  form.append(sourceInfo)
  const actions = el('div'); form.append(actions)
  button('Preview', async () => {
    if (!form.reportValidity()) return
    const data = collect()
    const r = await call('ah_preview', { ...data, context: { project_id: data.project_id } })
    preview.textContent = `${r.rendered_text}\n\nข้อมูลที่ขาด: ${r.missing.join(', ') || 'ไม่มี'}\nแหล่งข้อมูล: ${r.sources_used.join(', ') || 'ไม่มี'}\nคำเตือน: ${JSON.stringify(r.warnings)}\nไฟล์แนบ: ${(r.attachments ?? []).join('\n')}`
    setNotice('Preview จากข้อมูลในฟอร์ม — ยังไม่ได้บันทึก')
  }, actions)
  button('บันทึกร่าง / บันทึกการแก้ไข', () => save(false), actions)
  button('ส่งตรวจ', () => save(true), actions)
  const approve = button('Approve', () => transition('ah_approve'), actions)
  const retire = button('Retire', () => transition('ah_retire'), actions)
  form.append(el('h3', 'Preview'), preview, el('h3', 'ประวัติเวอร์ชัน'), history)
  form.onsubmit = e => e.preventDefault()
  form.addEventListener('input', () => { dirty = true; preview.textContent = 'ข้อมูลเปลี่ยนแล้ว กรุณา Preview ใหม่' })
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = '' } })
  function canLeave() { return !dirty || confirm('มีข้อมูลที่ยังไม่บันทึก ต้องการเปลี่ยนรายการหรือไม่?') }
  function addBinding(data = {}) {
    const row = el('div'); row.className = 'ae-binding'
    const sourceChoices = (options.sources ?? []).map(s => [s.id, `${s.source_code}${s.active ? '' : ' (ปิด)'}`])
    const b = { row }
    for (const [name, label, type, choices] of [
      ['variable_name', 'ตัวแปร'], ['source_id', 'แหล่งข้อมูล', 'text', sourceChoices], ['source_field', 'Field'],
      ['required', 'จำเป็น', 'checkbox'], ['fallback_text', 'ข้อความเมื่อไม่มีข้อมูล'], ['cache_ttl_seconds', 'Cache วินาที', 'number'],
    ]) {
      b[name] = field(`binding-${bindingRows.length}-${name}`, label, type, choices, row)
      if (type === 'checkbox') b[name].checked = data[name] ?? true
      else b[name].value = data[name] ?? (name === 'cache_ttl_seconds' ? 300 : name === 'source_id' ? sourceChoices[0]?.[0] ?? '' : '')
    }
    b.variable_name.required = true; b.variable_name.pattern = '[a-z_][a-z0-9_]*'
    b.cache_ttl_seconds.min = '0'
    button('ลบตัวแปร', () => { row.remove(); bindingRows.splice(bindingRows.indexOf(b), 1); dirty = true }, row)
    bindings.append(row); bindingRows.push(b)
  }
  function collect() {
    const data = {}
    for (const [name, n] of Object.entries(fields)) {
      data[name] = n.type === 'checkbox' ? n.checked : n.type === 'number' ? (n.value === '' ? null : Number(n.value))
        : n.type === 'datetime-local' ? (n.value ? new Date(n.value).toISOString() : null) : n.value
    }
    data.question_examples = lines(data.question_examples); data.attachments = lines(data.attachments)
    data.bindings = bindingRows.map(b => ({ variable_name: b.variable_name.value, source_id: b.source_id.value,
      source_field: b.source_field.value, required: b.required.checked, fallback_text: b.fallback_text.value || null,
      cache_ttl_seconds: Number(b.cache_ttl_seconds.value) }))
    if (current) data.id = current.id
    return data
  }
  function fill(item = null, versions = [], savedBindings = []) {
    current = item
    const defaults = { language: 'th', answer_type: 'static', audience: 'both', source_type: 'manual', show_in_quick_answer: true, priority: 100 }
    for (const [name, n] of Object.entries(fields)) {
      const value = item?.[name] ?? defaults[name] ?? ''
      if (n.type === 'checkbox') n.checked = Boolean(value)
      else if (n.type === 'datetime-local' && value) { const d = new Date(value); n.value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
      else n.value = Array.isArray(value) ? value.join('\n') : value
    }
    bindings.replaceChildren(); bindingRows.length = 0; savedBindings.forEach(addBinding)
    status.textContent = item ? `สถานะ: ${item.status} · ${item.id}` : 'คำตอบใหม่'
    approve.hidden = retire.hidden = options.role !== 'admin'
    approve.disabled = !item || !['draft', 'review'].includes(item.status)
    retire.disabled = !item || item.status === 'retired'
    for (const n of form.querySelectorAll('input,textarea,select,button')) {
      if (n !== approve && n !== retire) n.disabled = item?.status === 'retired'
    }
    history.replaceChildren()
    if (!versions.length) history.append(el('p', 'ยังไม่มีประวัติเวอร์ชัน'))
    for (const v of versions) {
      const d = el('details'); d.append(el('summary', `v${v.version_no} · ${v.created_at} · ${v.change_reason ?? ''}`), el('pre', JSON.stringify(v.snapshot, null, 2))); history.append(d)
    }
    preview.textContent = ''; dirty = false
  }
  async function open(id) {
    const r = await call('ah_editor_get', { id }); fill(r.item, r.versions, r.bindings)
  }
  async function save(submit) {
    if (!form.reportValidity()) return
    const saved = await call('ah_save', { ...collect(), submit })
    // Remember a successful create before reloading so a read failure cannot duplicate it.
    current = saved; dirty = false
    await open(saved.id); await loadList(); setNotice(submit ? 'ส่งตรวจแล้ว' : 'บันทึกแล้ว')
  }
  async function transition(action) {
    if (!current) return
    if (dirty) { setNotice('กรุณาบันทึกการแก้ไขก่อน'); return }
    if (!confirm(action === 'ah_retire' ? 'ยืนยันปลดใช้คำตอบนี้?' : 'ยืนยันอนุมัติคำตอบนี้?')) return
    await call(action, { id: current.id, reason: fields.change_reason.value })
    await open(current.id); await loadList(); setNotice('เปลี่ยนสถานะแล้ว')
  }
  async function loadList() {
    setNotice('กำลังโหลด…')
    const r = await call('ah_list', { query: search.value, status: filter.value || undefined, page, page_size: 20 })
    list.replaceChildren(); list.append(el('p', `หน้า ${page} · ทั้งหมด ${r.total} คำตอบ`))
    if (!r.rows?.length) list.append(el('p', 'ไม่พบคำตอบ'))
    for (const a of r.rows ?? []) button(`${a.title} · ${a.status}`, () => { if (canLeave()) return open(a.id) }, list)
    next.disabled = page * 20 >= r.total
    setNotice('พร้อมใช้งาน')
  }
  fill(); await run(loadList)
}
