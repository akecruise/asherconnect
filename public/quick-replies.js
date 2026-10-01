
/* Selection prepares a draft; it never sends. */
(() => {
  const button = document.getElementById('quick-replies'), message = document.getElementById('message'), menu = document.getElementById('template-menu')
  if (!button || !message || !menu) return
  window.asherQuickRepliesEnabled = true

  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-controls', 'template-menu')

  let query = '', sort = 'frequent', index = 0, mode = 'button', cache = null, loading = false, failed = false, inserting = false, visible = [], list, search, status, requestVersion = 0, insertRange = null
  const usage = new Map()
  const el = (tag, content, cls) => { const e = document.createElement(tag); if (content != null) e.textContent = content; if (cls) e.className = cls; return e }
  const context = () => window.asherQuickReplyContext?.() || {}
  const unwrap = raw => Array.isArray(raw) ? raw : (raw?.quick_replies || raw?.templates || raw?.items || [])
  const rows = () => unwrap(cache ?? window.asherQuickReplies?.() ?? []).filter(x => (x.active ?? x.is_active) !== false).map(x => ({ ...x, name: x.title || x.name || x.shortcut || 'Quick reply', shortcut: String(x.shortcut || '').replace(/^\//, ''), content: x.body ?? x.content ?? x.message ?? '', usage_count: Math.max(Number(x.usage_count || 0), usage.get(x.id)?.usage_count || 0), last_used_at: [x.last_used_at || '', usage.get(x.id)?.last_used_at || ''].sort().at(-1) }))
  const api = async (action, data = {}) => { const r = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data }) }); if (!r.ok) throw new Error('request_failed'); return r.json() }
  const filtered = () => rows().filter(x => `${x.shortcut} ${x.name} ${x.content}`.toLocaleLowerCase().includes(query.replace(/^\//, '').toLocaleLowerCase())).sort((a, b) => {
    const exact = x => query && x.shortcut.toLowerCase() === query.replace(/^\//, '').toLowerCase() ? 1 : 0
    return exact(b) - exact(a) || (sort === 'frequent' ? Number(b.usage_count || 0) - Number(a.usage_count || 0) : sort === 'recent' ? String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')) : a.name.localeCompare(b.name, 'th')) || Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.name.localeCompare(b.name, 'th')
  })
  function close () { requestVersion++; loading = false; menu.hidden = true; button.setAttribute('aria-expanded', 'false'); message.removeAttribute('aria-controls'); message.removeAttribute('aria-activedescendant'); menu.replaceChildren() }
  async function refresh () {
    const version = ++requestVersion
    loading = true; failed = false
    // แสดงรายการที่มีอยู่ทันที แล้วค่อยวาดใหม่เฉพาะเมื่อข้อมูลจากเซิร์ฟเวอร์เปลี่ยนจริง
    // (วาดใหม่ทุกครั้ง = รายการกระพริบ เลื่อนหลุด และนิ้วที่กำลังจะแตะไปโดนแถวอื่น)
    const before = JSON.stringify(unwrap(cache ?? window.asherQuickReplies?.() ?? []))
    let changed = false
    try { const result = unwrap(await api('quick_replies_list')); if (version !== requestVersion) return; changed = JSON.stringify(result) !== before; cache = result } catch { if (version === requestVersion) failed = true } finally { if (version === requestVersion) { loading = false; if (!menu.hidden && (changed || failed)) render(); else if (status && !failed) status.textContent = `${visible.length} รายการ` } }
  }
  // มือถือ/แท็บเล็ต: อย่าเรียกคีย์บอร์ดขึ้นเอง จอจะหดและแผงกระตุกเหมือนกดไม่ติด
  const touch = () => window.matchMedia?.('(pointer: coarse)').matches ?? false
  function choose (item) {
    const range = insertRange
    // เลือกจากปุ่มบนมือถือ: ใส่ข้อความแล้วพร้อมกดส่งเลย ไม่ต้องเด้งคีย์บอร์ด (แบบ LINE)
    const focus = !(mode === 'button' && touch())
    close()
    inserting = true
    try {
      if (window.asherInsertQuickReply) window.asherInsertQuickReply(item, range, { focus })
      else { message.value = message.value.slice(0, range?.start ?? 0) + item.content + message.value.slice(range?.end ?? message.value.length); message.dispatchEvent(new Event('input', { bubbles: true })); if (focus) message.focus() }
    } finally { inserting = false }
    usage.set(item.id, { usage_count: Number(item.usage_count || 0) + 1, last_used_at: new Date().toISOString() })
    const data = { id: item.id }; if (context().conversation_id) data.conversation_id = context().conversation_id
    void api('quick_reply_use', data).catch(() => {})
  }
  function highlight () {
    list?.querySelectorAll('.quick-reply-row').forEach((b, i) => { b.classList.toggle('active', i === index); b.setAttribute('aria-selected', String(i === index)) })
    const active = list?.children[index]
    if (active && visible.length) { message.setAttribute('aria-activedescendant', active.id); search?.setAttribute('aria-activedescendant', active.id) }
  }
  function render () {
    if (menu.hidden || !list) return
    visible = filtered(); index = Math.max(0, Math.min(index, visible.length - 1)); list.replaceChildren()
    status.textContent = failed ? 'โหลดข้อมูลล่าสุดไม่สำเร็จ · ปิดแล้วเปิดอีกครั้งเพื่อลองใหม่' : loading && !visible.length ? 'กำลังโหลด…' : `${visible.length} รายการ`
    if (!visible.length) list.append(el('div', 'ไม่พบ Quick Reply ที่ตรงกัน', 'template-empty'))
    visible.forEach((item, i) => {
      const b = el('button', null, 'quick-reply-row'); b.type = 'button'; b.id = `quick-reply-option-${i}`; b.setAttribute('role', 'option')
      const image = item.thumbnail_url || item.image_url || item.attachments?.find(a => a.mime_type?.startsWith('image/') || a.kind === 'image')?.public_url
      if (image && (/^https:\/\//i.test(image) || /^\/(?!\/)/.test(image))) { const img = el('img'); img.src = image; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.addEventListener('error', () => { img.hidden = true }); b.append(img) } else b.append(el('span', '⌘', 'quick-reply-thumb'))
      const copy = el('span', null, 'quick-reply-copy'); copy.append(el('strong', item.name), el('code', item.shortcut ? `/${item.shortcut}` : 'ไม่มี shortcut'), el('small', item.content)); b.append(copy)
      b.addEventListener('click', () => choose(item)); b.addEventListener('focus', () => { index = i; highlight() }); list.append(b)
    })
    highlight()
  }
  function open (kind = 'button') {
    mode = kind; menu.hidden = false; menu.className = 'template-menu quick-replies-popover'; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Quick Replies'); menu.replaceChildren(); button.setAttribute('aria-expanded', 'true'); message.setAttribute('aria-controls', 'quick-replies-list')
    const head = el('div', null, 'quick-replies-head'), title = el('strong', 'คำตอบที่บันทึกไว้'); title.append(el('small', 'SAVED REPLIES')); head.append(title)
    if (context().role === 'admin') { const link = el('a', 'จัดการ'); link.href = '/quick-replies'; head.append(link) }
    const dismiss = el('button', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'ปิด Quick Replies'); dismiss.addEventListener('click', () => { close(); message.focus() }); head.append(dismiss); menu.append(head)
    const tools = el('div', null, 'quick-replies-tools'); search = el('input'); search.type = 'search'; search.placeholder = 'ค้นหาคำตอบ หรือ /shortcut'; search.setAttribute('aria-label', 'ค้นหาคำตอบที่บันทึกไว้'); search.value = query
    const select = el('select'); select.setAttribute('aria-label', 'เรียงคำตอบ'); [['frequent', 'ใช้บ่อยที่สุด'], ['recent', 'ใช้ล่าสุด'], ['az', 'เรียง ก–ฮ']].forEach(([value, label]) => { const o = el('option', label); o.value = value; select.append(o) }); select.value = sort; tools.append(search, select); menu.append(tools)
    status = el('div', '', 'quick-replies-status'); status.setAttribute('role', 'status'); list = el('div'); list.id = 'quick-replies-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'คำตอบที่บันทึกไว้'); menu.append(status, list, el('p', 'แตะคำตอบเพื่อใส่ข้อความ · ↑ ↓ เลือก · Enter ใส่ · Esc ปิด', 'quick-replies-help'))
    search.addEventListener('input', () => { query = search.value; index = 0; render() }); select.addEventListener('change', () => { sort = select.value; index = 0; render() }); render(); void refresh()
    if (kind === 'button' && !touch()) search.focus()
  }
  button.addEventListener('click', () => { if (!menu.hidden) close(); else { query = ''; index = 0; insertRange = { start: message.selectionStart ?? message.value.length, end: message.selectionEnd ?? message.value.length }; open() } })
  message.addEventListener('input', () => {
    if (inserting) return
    const caret = message.selectionStart ?? message.value.length
    const token = message.value.slice(0, caret).match(/(?:^|\s)\/([^\s/]*)$/)
    if (token) { query = token[1]; insertRange = { start: caret - query.length - 1, end: caret }; index = 0; if (menu.hidden || mode !== 'slash') { open('slash') } else { search.value = query; render() } }
    else if (!menu.hidden && mode === 'slash') close()
  })
  // Capture before the existing textarea Enter-to-send handler, including no matches.
  document.addEventListener('keydown', e => {
    if (menu.hidden || (e.target !== message && !menu.contains(e.target))) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); message.focus(); return }
    if (e.isComposing || e.keyCode === 229) { if (e.key === 'Enter' || e.keyCode === 229) e.stopImmediatePropagation(); return }
    if (e.target !== message && e.target !== search && !e.target.classList.contains('quick-reply-row')) return
    if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
      e.preventDefault(); e.stopImmediatePropagation()
      if (!visible.length) return
      if (e.key === 'Enter') choose(visible[index])
      else { index = (index + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length; highlight(); list.children[index]?.scrollIntoView({ block: 'nearest' }) }
    }
  }, true)
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target) && e.target !== message) close() })
  window.addEventListener('focus', () => { if (!menu.hidden) void refresh() })
})()

