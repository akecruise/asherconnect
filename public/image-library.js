/* คลังรูป (Image Library) — ใช้ร่วมกันระหว่างแท็บ "คลังรูป" ใน popover ของช่องตอบ
   กับหน้าเมนู /media-library · ด่านสิทธิ์จริงอยู่ที่ inbox.media_* ในฐาน
   ที่นี่ซ่อนปุ่มตามบทบาทเพื่อความสะอาดตาเท่านั้น */
(function () {
  const CATEGORIES = [['', 'ทั้งหมด'], ['room', 'ห้อง'], ['plan', 'แปลน'], ['facility', 'ส่วนกลาง (facility)'], ['exterior', 'ภายนอกอาคาร (exterior)'], ['location', 'ทำเล'], ['promo', 'โปรโมชั่น'], ['other', 'อื่น ๆ']]
  const PROJECTS = [['', 'ทุกโครงการ'], ['naii', 'Asher Naii'], ['vibe', 'Asher Vibe']]
  const EDITORS = ['marketing', 'manager', 'admin']
  const FULL_EDGE = 2048, PREVIEW_EDGE = 480

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else if (v === true) node.setAttribute(k, '')
      else if (v !== false && v != null) node.setAttribute(k, v)
    }
    node.append(...children.filter(c => c != null))
    return node
  }
  const categoryName = v => (CATEGORIES.find(c => c[0] === v) || [, v])[1]
  const projectName = v => v === 'all' ? 'ทุกโครงการ' : (PROJECTS.find(p => p[0] === v) || [, v])[1]
  const thumbOf = a => '/library-media/' + (a.preview_path || a.storage_path)

  async function api (action, data = {}) {
    const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data }) })
    const body = await response.json().catch(() => ({}))
    const known = { not_allowed: 'ไม่มีสิทธิ์ทำรายการนี้', media_not_found: 'ไม่พบรูปนี้ (อาจถูกนำออกแล้ว)', session_expired: 'หมดเวลาเข้าสู่ระบบ กรุณารีเฟรชหน้า', body_too_large: 'ไฟล์ใหญ่เกินไป' }
    if (!response.ok) throw new Error(known[body.error] || (/[\u0E00-\u0E7F]/.test(body.error || '') ? body.error : 'ทำรายการไม่สำเร็จ'))
    return body
  }

  // ย่อ + แปลงเป็น JPEG ในเบราว์เซอร์ (WEBP/PNG/HEIC ที่เบราว์เซอร์เปิดได้ → JPEG)
  // server รับเฉพาะ JPEG/PNG และตรวจ magic bytes ซ้ำ — image ฝั่ง server ไม่มีตัวแปลงรูป (ตั้งใจ)
  async function encode (bitmap, edge, quality) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = el('canvas'); canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) throw new Error('แปลงรูปไม่สำเร็จ')
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { data: btoa(binary), width: w, height: h, size: blob.size }
  }
  async function prepareFile (file) {
    if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: ใหญ่เกิน 25 MB`)
    let bitmap
    try { bitmap = await createImageBitmap(file) } catch { throw new Error(`${file.name}: เปิดรูปไม่ได้ (รองรับ JPG, PNG, WEBP)`) }
    const full = await encode(bitmap, FULL_EDGE, 0.88)
    const preview = await encode(bitmap, PREVIEW_EDGE, 0.8)
    bitmap.close?.()
    if (full.size > 10 * 1024 * 1024) throw new Error(`${file.name}: ใหญ่เกิน 10 MB หลังย่อ`)
    return { full, preview }
  }

  // ฟอร์ม "+ เพิ่มรูปเข้าคลัง" — ใช้ได้ทั้งใน popover และหน้าจัดการ
  function uploadForm ({ role, project = '', onDone, onCancel }) {
    const editor = EDITORS.includes(role)
    const files = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, required: true })
    const title = el('input', { type: 'text', maxlength: '160', placeholder: 'เช่น ห้อง 1 Bedroom 30 ตร.ม.' })
    const proj = el('select', {}, ...PROJECTS.slice(1).concat([['all', 'ทุกโครงการ']]).map(([v, t]) => el('option', { value: v, text: t })))
    proj.value = project || 'all'
    const cat = el('select', {}, ...CATEGORIES.slice(1).map(([v, t]) => el('option', { value: v, text: t })))
    const expires = el('input', { type: 'date' })
    const bot = el('input', { type: 'checkbox' })
    const status = el('p', { class: 'image-library-status', role: 'status' })
    const submit = el('button', { type: 'submit', class: 'primary', text: 'อัปโหลด' })
    const form = el('form', { class: 'image-library-form' },
      el('label', {}, 'ไฟล์รูป (เลือกได้หลายรูป)', files),
      el('label', {}, 'ชื่อรูป (หลายรูปจะต่อท้ายด้วยเลข 1, 2, …)', title),
      el('div', { class: 'image-library-form-row' }, el('label', {}, 'โครงการ', proj), el('label', {}, 'หมวด', cat), el('label', {}, 'หมดอายุ (ถ้ามี)', expires)),
      editor ? el('label', { class: 'image-library-check' }, bot, 'ให้บอทใช้รูปนี้ได้') : null,
      editor ? null : el('p', { class: 'image-library-hint', text: 'รูปที่เซลส์เพิ่มจะรอ marketing / manager อนุมัติก่อนขึ้นคลัง' }),
      status,
      el('div', { class: 'image-library-actions' }, onCancel ? el('button', { type: 'button', class: 'subtle', text: 'ยกเลิก', onclick: onCancel }) : null, submit))
    form.addEventListener('submit', async e => {
      e.preventDefault()
      const list = [...files.files]
      if (!list.length) return
      const baseTitle = title.value.trim() || list[0].name.replace(/\.[^.]+$/, '')
      submit.disabled = true; status.classList.remove('error')
      const created = []
      try {
        for (let i = 0; i < list.length; i++) {
          status.textContent = `กำลังอัปโหลด ${i + 1}/${list.length}…`
          const { full, preview } = await prepareFile(list[i])
          created.push(await api('media_library_upload', {
            title: list.length > 1 ? `${baseTitle} ${i + 1}` : baseTitle, project: proj.value, category: cat.value,
            expires_at: expires.value ? new Date(expires.value + 'T23:59:59+07:00').toISOString() : null,
            bot_enabled: bot.checked, file: { data: full.data, width: full.width, height: full.height }, preview: { data: preview.data },
          }))
        }
        status.textContent = editor ? `เพิ่มแล้ว ${created.length} รูป` : `ส่งแล้ว ${created.length} รูป — รออนุมัติ`
        form.reset(); onDone?.(created)
      } catch (err) {
        status.textContent = (created.length ? `เพิ่มได้ ${created.length} รูป แล้วสะดุด: ` : '') + err.message; status.classList.add('error')
        if (created.length) onDone?.(created)
      } finally { submit.disabled = false }
    })
    return form
  }

  function card (asset, { index, selected, onToggle, extra }) {
    const img = el('img', { src: thumbOf(asset), alt: '', loading: 'lazy' })
    img.addEventListener('error', () => img.classList.add('broken'))
    const badges = el('span', { class: 'image-library-badges' },
      asset.sent_to_conversation ? el('span', { class: 'image-library-sent', text: 'ส่งแล้ว' }) : null,
      asset.status === 'pending' ? el('span', { class: 'image-library-pending', text: 'รออนุมัติ' }) : null,
      asset.expires_at && new Date(asset.expires_at) < new Date() ? el('span', { class: 'image-library-expired', text: 'หมดอายุ' }) : null)
    const tile = el(onToggle ? 'button' : 'div', { class: 'image-library-tile' + (selected ? ' selected' : ''), type: onToggle ? 'button' : null, 'aria-pressed': onToggle ? String(!!selected) : null, title: asset.title },
      img, selected ? el('span', { class: 'image-library-order', text: String(index) }) : null, badges,
      el('span', { class: 'image-library-caption', text: asset.title }), extra || null)
    if (onToggle) tile.addEventListener('click', () => onToggle(asset))
    return tile
  }

  function filters (state, onChange, { withProject = true } = {}) {
    const search = el('input', { type: 'search', placeholder: 'ค้นหาชื่อรูป', value: state.q || '' })
    let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value; onChange() }, 250) })
    const project = el('select', { 'aria-label': 'โครงการ' }, ...PROJECTS.map(([v, t]) => el('option', { value: v, text: t })))
    project.value = state.project || ''; project.addEventListener('change', () => { state.project = project.value; onChange() })
    const sort = el('select', { 'aria-label': 'เรียง' }, el('option', { value: 'freq', text: 'ใช้บ่อย' }), el('option', { value: 'recent', text: 'ล่าสุด' }))
    sort.value = state.sort || 'freq'; sort.addEventListener('change', () => { state.sort = sort.value; onChange() })
    const chips = el('div', { class: 'quick-replies-cats image-library-cats' }, ...CATEGORIES.map(([v, t]) => {
      const b = el('button', { type: 'button', class: (state.category || '') === v ? 'active' : '', text: t })
      b.addEventListener('click', () => { state.category = v; chips.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); onChange() })
      return b
    }))
    return el('div', { class: 'image-library-filters' }, el('div', { class: 'quick-replies-tools' }, search, withProject ? project : null, sort), chips)
  }

  // แท็บ "คลังรูป" ใน popover ของช่องตอบ
  function render (container, { close }) {
    const ctx = typeof window.asherComposerContext === 'function' ? window.asherComposerContext() : {}
    const state = { project: ctx.project || '', category: '', q: '', sort: 'freq' }
    const picked = []
    const grid = el('div', { class: 'image-library-grid', role: 'list' })
    const attach = el('button', { type: 'button', class: 'primary', text: 'แนบในช่องตอบ', disabled: true })
    const count = el('small', { class: 'muted' })
    const body = el('div', { class: 'image-library-body' })
    let rows = []
    const paint = () => {
      grid.replaceChildren()
      if (!rows.length) { grid.append(el('div', { class: 'template-empty', text: 'ยังไม่มีรูปที่ตรงกัน' })); }
      rows.forEach(a => grid.append(card(a, { index: picked.findIndex(p => p.id === a.id) + 1, selected: picked.some(p => p.id === a.id), onToggle: toggle })))
      attach.disabled = !picked.length
      count.textContent = picked.length ? `เลือก ${picked.length} รูป (สูงสุด ${ctx.max ?? 5})` : 'แตะรูปเพื่อเลือก ลำดับที่แตะคือลำดับที่ส่ง'
    }
    const toggle = a => {
      const i = picked.findIndex(p => p.id === a.id)
      if (i >= 0) picked.splice(i, 1)
      else if (picked.length + (ctx.count || 0) >= (ctx.max ?? 5)) { count.textContent = `แนบได้อีก ${Math.max(0, (ctx.max ?? 5) - (ctx.count || 0))} รูป`; return }
      else picked.push(a)
      paint()
    }
    const load = async () => {
      grid.replaceChildren(el('div', { class: 'template-empty', text: 'กำลังโหลด…' }))
      try { rows = await api('media_library_list', { project: state.project, category: state.category, q: state.q, sort: state.sort, conversation_id: ctx.conversationId }) }
      catch (e) { rows = []; grid.replaceChildren(el('div', { class: 'template-empty error', text: e.message })); return }
      paint()
    }
    attach.addEventListener('click', () => { if (window.asherAttachLibraryImages?.(picked)) close() })
    const canAdd = !ctx.testOnly && ['sales', 'senior_sales', ...EDITORS].includes(ctx.role)
    const addBtn = canAdd ? el('button', { type: 'button', class: 'subtle', text: '+ เพิ่มรูปเข้าคลัง' }) : null
    addBtn?.addEventListener('click', () => {
      body.replaceChildren(uploadForm({ role: ctx.role, project: state.project, onCancel: () => showGrid(), onDone: () => { load(); setTimeout(showGrid, 900) } }))
    })
    const showGrid = () => body.replaceChildren(filters(state, load), grid, el('div', { class: 'image-library-footer' }, count, el('span', { class: 'image-library-footer-actions' }, addBtn, attach)))
    container.append(body); showGrid(); load()
  }

  window.asherImageLibrary = { render, uploadForm, card, filters, api, categoryName, projectName, thumbOf, CATEGORIES, PROJECTS, EDITORS, el }
})()
