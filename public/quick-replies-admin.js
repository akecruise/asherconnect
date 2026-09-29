/* APLUS shared saved replies. All writes are authorized again by the server. */
(() => {
  'use strict'
  const $ = id => document.getElementById(id)
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n }
  let replies = [], isAdmin = false, editingId = null, duplicateOf = null, importRows = [], busy = false
  const messages = { forbidden: 'เฉพาะ Admin เท่านั้นที่จัดการ Quick Replies ได้', not_allowed: 'เฉพาะ Admin เท่านั้นที่จัดการ Quick Replies ได้', unauthorized: 'กรุณาเข้าสู่ระบบจากหน้า Inbox', duplicate_shortcut: 'Shortcut นี้มีอยู่แล้ว กรุณาใช้ชื่ออื่น', duplicate_message: 'ข้อความนี้มีอยู่แล้ว กรุณาแก้ไขรายการเดิม', invalid_input: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง', category_not_allowed: 'Category ต้องเป็นหมวดในระบบ เช่น ราคา โปรโมชั่น นัดชม ทำเล ห้องว่าง การจอง', attachment_image_only: 'ตอนนี้รองรับไฟล์แนบรูปภาพเท่านั้น (PNG, JPEG, WebP)', unsupported_media_type: 'รองรับ PNG, JPEG, WebP หรือ PDF เท่านั้น', body_too_large: 'ไฟล์ใหญ่เกินที่ระบบรับได้ (สูงสุด 10 MB)' }
  async function responseData(response) { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(messages[data.error] || data.message || data.error || `HTTP ${response.status}`); return data }
  const api = (action, data = {}) => fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data }) }).then(responseData)
  const field = name => $('editor-form').elements.namedItem(name)
  // ลิงก์แนบยอมรับสองแบบ: HTTPS URL ภายนอก และพาธ same-origin /media/… ที่ endpoint อัปโหลดคืนให้ (bucket inbox-media)
  const https = value => { if (/^\/media\/\S+$/.test(value)) return value; try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : '' } catch { return '' } }
  const nameOf = row => row.title || row.name || row.shortcut || 'Quick Reply'
  const bodyOf = row => row.body || row.content || row.message || ''
  const activeOf = row => row.active !== false && row.is_active !== false
  function notify(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : '' }
  function button(label, fn) { const b = el('button', label); b.type = 'button'; b.addEventListener('click', fn); return b }
  async function refresh() {
    const result = await api('quick_replies_list', { include_inactive: isAdmin }); replies = Array.isArray(result) ? result : result.templates || result.quick_replies || []
    const current = $('category-filter').value; $('category-filter').replaceChildren(new Option('ทุกหมวดหมู่', ''))
    ;[...new Set(replies.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')).forEach(c => $('category-filter').append(new Option(c, c)))
    $('category-filter').value = current; render()
  }
  function render() {
    const query = $('search').value.trim().toLocaleLowerCase(); const category = $('category-filter').value; const status = $('status-filter').value
    const rows = replies.filter(r => `${r.shortcut || ''} ${nameOf(r)} ${bodyOf(r)} ${r.category || ''}`.toLocaleLowerCase().includes(query) && (!category || r.category === category) && (!status || activeOf(r) === (status === 'active')))
    const sort = $('sort').value; rows.sort((a, b) => sort === 'frequent' ? Number(b.usage_count || 0) - Number(a.usage_count || 0) : sort === 'recent' ? String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')) : sort === 'name' ? nameOf(a).localeCompare(nameOf(b), 'th') : Number(a.sort_order || 0) - Number(b.sort_order || 0))
    $('count').textContent = `${rows.length} รายการ · ${replies.length} ทั้งหมด`; $('replies').replaceChildren()
    if (!rows.length) $('replies').append(el('p', 'ไม่พบ Quick Reply — ลองค้นหาใหม่ หรือสร้างข้อความแรก', 'empty'))
    for (const row of rows) {
      const card = el('article', null, 'reply'); const image = https(row.thumbnail_url || row.image_url || row.attachments?.[0]?.public_url || '')
      if (image) { const img = el('img', null, 'thumbnail'); img.src = image; img.alt = ''; img.loading = 'lazy'; img.addEventListener('error', () => img.replaceWith(el('span', '⌘', 'thumbnail')), { once: true }); card.append(img) } else card.append(el('span', '⌘', 'thumbnail'))
      const copy = el('div'); copy.append(el('span', '/' + (row.shortcut || '—'), 'shortcut'), el('h3', nameOf(row)), el('p', bodyOf(row), 'preview')); if (row.source) copy.append(el('small', `Source: ${row.source}${row.source_shortcut ? ' · /' + row.source_shortcut : ''}${row.imported_at ? ' · นำเข้า ' + new Date(row.imported_at).toLocaleDateString('th-TH') : ''}`)); card.append(copy)
      const category = el('div', null, 'metric'); category.append(el('small', 'Category'), el('span', row.category || 'ทั่วไป')); card.append(category)
      const state = el('div', null, 'metric'); state.append(el('span', activeOf(row) ? 'Active' : 'Inactive', 'badge' + (activeOf(row) ? '' : ' inactive')), el('small', `ลำดับ ${row.sort_order || 0}`)); card.append(state)
      const usage = el('div', null, 'metric'); usage.append(el('strong', String(row.usage_count || 0)), el('small', 'ครั้งที่ใช้งาน')); if (row.last_used_at) usage.title = `ใช้ล่าสุด ${new Date(row.last_used_at).toLocaleString('th-TH')}`; card.append(usage)
      const actions = el('div', null, 'row-actions'); if (isAdmin) actions.append(button('Edit', () => edit(row)), button('Duplicate', () => edit(row, true)), button(activeOf(row) ? 'Disable' : 'Enable', async () => { if (busy) return; busy = true; try { await api('quick_reply_toggle', { id: row.id, active: !activeOf(row) }); await refresh(); notify('บันทึกสถานะแล้ว') } catch (e) { notify(e.message, true) } finally { busy = false } })); card.append(actions); $('replies').append(card)
    }
  }
  function addAttachment(attachment = {}) {
    const wrap = el('div', null, 'attachment'); const url = el('input'); url.placeholder = 'https://… หรือ /media/…'; url.setAttribute('aria-label', 'Attachment URL'); url.value = attachment.public_url || attachment.url || ''; url.required = true
    const type = el('select'); type.setAttribute('aria-label', 'Attachment type'); [['image', 'รูปภาพ'], ['file', 'เอกสาร']].forEach(([value, label]) => type.append(new Option(label, value))); type.value = attachment.mime_type?.startsWith('image/') || attachment.type === 'image' ? 'image' : 'file'; if (!attachment.public_url && !attachment.url) type.value = 'image'
    wrap.append(url, type, button('✕', () => wrap.remove())); wrap.lastChild.setAttribute('aria-label', 'ลบไฟล์แนบ'); wrap.dataset.fileName = attachment.file_name || ''; wrap.dataset.mimeType = attachment.mime_type || ''; $('attachments').append(wrap)
    const preview = el('img', null, 'attachment-preview'); preview.alt = 'ตัวอย่างรูปแนบ'; preview.hidden = true; wrap.append(preview)
    const updatePreview = () => { const src = https(url.value.trim()); preview.hidden = !src || type.value !== 'image'; if (!preview.hidden) preview.src = src }; preview.addEventListener('error', () => { preview.hidden = true }); url.addEventListener('change', updatePreview); type.addEventListener('change', updatePreview); updatePreview()
  }
  function edit(row = {}, duplicate = false) {
    if (!isAdmin) return; editingId = duplicate ? null : row.id || null; duplicateOf = duplicate ? row.id : null; $('editor-form').reset(); $('editor-error').textContent = ''; $('attachments').replaceChildren()
    let shortcut = row.shortcut || ''; if (duplicate) { const base = shortcut.slice(0, 52) || 'reply'; let n = 1; do { shortcut = `${base}_copy${n++}` } while (replies.some(r => String(r.shortcut).toLowerCase() === shortcut.toLowerCase())) }
    field('shortcut').value = shortcut; field('title').value = row.id ? nameOf(row) + (duplicate ? ' (สำเนา)' : '') : ''; field('body').value = bodyOf(row); field('category').value = row.category || ''; field('active').checked = activeOf(row); field('sort_order').value = row.sort_order || 0
    ;(row.attachments || (row.image_url ? [{ public_url: row.image_url, type: 'image' }] : [])).forEach(addAttachment)
    $('editor-title').textContent = duplicate ? 'Duplicate Reply' : editingId ? 'Edit Reply' : 'Create Reply'; if (duplicate) $('editor-error').textContent = 'รายการนี้มีข้อความซ้ำกับต้นฉบับ กด Save เพื่อยืนยันสร้างสำเนาโดยใช้ shortcut ใหม่'
    counter(); $('editor').showModal(); field('shortcut').focus()
  }
  function counter() { $('character-count').textContent = `${field('body').value.length.toLocaleString()} / 10,000` }
  $('editor-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!isAdmin || busy) return; $('editor-error').textContent = ''
    const attachments = [...$('attachments').children].map(n => ({ public_url: https(n.querySelector('input').value.trim()), file_name: n.dataset.fileName || 'attachment', mime_type: n.dataset.mimeType || (n.querySelector('select').value === 'image' ? 'image/jpeg' : 'application/octet-stream') }))
    if (attachments.some(a => !a.public_url)) { $('editor-error').textContent = 'ไฟล์แนบต้องเป็น HTTPS URL หรือพาธ /media/ ที่ถูกต้อง'; return }
    const data = { title: field('title').value.trim(), body: field('body').value.trim(), shortcut: field('shortcut').value.trim().replace(/^\//, ''), category: field('category').value.trim(), project: 'all', active: field('active').checked, sort_order: Number(field('sort_order').value), attachments }; if (editingId) data.id = editingId
    if (duplicateOf) data.duplicate_of = duplicateOf
    busy = true; $('save').disabled = true
    try { await api('quick_reply_upsert', data); $('editor').close(); await refresh(); notify('บันทึก Quick Reply แล้ว ทีมขายสามารถเลือกใช้งานได้ทันที') } catch (e) { $('editor-error').textContent = e.message } finally { busy = false; $('save').disabled = false }
  })
  function importReady() { const ready = importRows.some(r => r.decision !== 'skip' && !r.errors.length); $('import-save').disabled = !ready || busy }
  function renderImport() {
    $('import-preview').replaceChildren(); const errors = importRows.filter(r => r.errors.length).length; const duplicates = importRows.filter(r => r.duplicate_ids.length).length
    $('import-status').textContent = `${importRows.length} รายการ · ซ้ำ ${duplicates} · ข้อมูลไม่ถูกต้อง ${errors} (จะข้ามรายการที่ไม่ถูกต้อง)`
    for (const row of importRows) {
      const card = el('div', null, 'import-row'); const copy = el('div'); copy.append(el('h3', `แถว ${row.row_number}: /${row.shortcut || '—'} · ${row.name || ''}`), el('p', row.message || '', 'preview')); if (row.duplicate_reason) copy.append(el('small', `ตรวจพบข้อมูลซ้ำ: ${Array.isArray(row.duplicate_reason) ? row.duplicate_reason.join(', ') : row.duplicate_reason}`)); card.append(copy)
      const label = el('label', 'Category'); const category = el('input'); category.value = row.category || ''; category.maxLength = 100; category.setAttribute('list', 'categories'); category.addEventListener('input', () => { row.category = category.value }); label.append(category); card.append(label)
      const choice = el('label', 'การนำเข้า'); const select = el('select'); select.append(new Option('Skip — ข้าม', 'skip')); if (!row.errors.length) { if (!row.duplicate_ids.length) select.append(new Option('Create — เพิ่มใหม่', 'create')); else if (row.duplicate_ids.length === 1) select.append(new Option('Update existing', 'update')) } select.value = row.decision; select.addEventListener('change', () => { row.decision = select.value; if (row.decision === 'update') row.target_id = row.duplicate_ids[0]; else delete row.target_id; importReady() }); choice.append(select); card.append(choice)
      if (row.errors.length) card.append(el('p', row.errors.join(' · '), 'error')); if (row.duplicate_ids.length > 1) card.append(el('p', 'พบหลายรายการที่ตรงกัน กรุณาแก้ข้อมูลซ้ำก่อนนำเข้า — ข้ามรายการนี้', 'error')); $('import-preview').append(card)
    } importReady()
  }
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; importRows = []; $('import-preview').replaceChildren(); importReady(); if (!file) return
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size > 5 * 1024 * 1024 || !file.size) { $('import-status').textContent = 'กรุณาเลือก CSV UTF-8 หรือ XLSX ที่ไม่ว่างและขนาดไม่เกิน 5 MB'; return }
    const form = new FormData(); form.append('file', file); $('import-status').textContent = 'กำลังตรวจสอบไฟล์…'; busy = true; $('import-file').disabled = true
    try { const result = await fetch('/api/quick-replies/import/preview', { method: 'POST', body: form }).then(responseData); importRows = (result.rows || []).map((r, i) => ({ ...r, row_number: r.row_number || i + 2, errors: r.errors || [], duplicate_ids: r.duplicate_ids || [], decision: (r.errors?.length || r.duplicate_ids?.length) ? 'skip' : 'create' })); renderImport() } catch (e) { $('import-status').textContent = e.message } finally { busy = false; $('import-file').disabled = false; importReady() }
  })
  $('import-save').addEventListener('click', async () => {
    if (!isAdmin || busy) return; busy = true; importReady(); $('import-status').textContent = 'กำลังบันทึก…'
    try { const result = await api('quick_reply_import', { rows: importRows }); const summary = result.summary || result; $('import-status').textContent = `นำเข้าสำเร็จ · เพิ่ม ${summary.created ?? summary.inserted ?? 0} · อัปเดต ${summary.updated ?? 0} · ข้าม ${summary.skipped ?? 0}`; importRows = []; $('import-preview').replaceChildren(); await refresh(); notify($('import-status').textContent) } catch (e) { $('import-status').textContent = e.message } finally { busy = false; importReady() }
  })
  $('download-template').addEventListener('click', () => { const blob = new Blob(['\uFEFFshortcut,name,message,category,active,sort_order,source,image_url\r\nA9,ข้อมูล A9,"ข้อความตัวอย่างโครงการ A9",ข้อมูลโครงการ,true,10,facebook,\r\nPRICE,ราคา,"ราคาเริ่มต้น 2 ล้านบาท",ราคา,true,20,facebook,\r\n'], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = el('a'); a.href = url; a.download = 'facebook-saved-replies-template.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) })
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { if (!busy) $(b.dataset.close).close() }))
  ;['editor', 'importer'].forEach(id => $(id).addEventListener('cancel', event => { if (busy) event.preventDefault() }))
  ;['search', 'category-filter', 'status-filter', 'sort'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', render))
  const uploadLabel = el('label', 'อัปโหลดรูปภาพ / PDF (สูงสุด 10 MB)'); const uploadInput = el('input'); uploadInput.type = 'file'; uploadInput.accept = 'image/png,image/jpeg,image/webp,application/pdf'; uploadLabel.append(uploadInput); $('attachments').before(uploadLabel)
  uploadInput.addEventListener('change', async () => { const file = uploadInput.files[0]; if (!file || busy) return; if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) { $('editor-error').textContent = 'รองรับ PNG, JPEG, WebP หรือ PDF ขนาดไม่เกิน 10 MB'; uploadInput.value = ''; return } busy = true; uploadInput.disabled = true; $('save').disabled = true; $('editor-error').textContent = 'กำลังอัปโหลด…'; try { const uploaded = await fetch('/api/quick-replies/attachment', { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file }).then(responseData); addAttachment(uploaded); $('editor-error').textContent = '' } catch (e) { $('editor-error').textContent = e.message } finally { busy = false; uploadInput.disabled = false; uploadInput.value = ''; $('save').disabled = false } })
  field('body').addEventListener('input', counter); $('add-attachment').addEventListener('click', () => addAttachment()); $('create').addEventListener('click', () => edit()); $('import-open').addEventListener('click', () => { if (!busy) $('importer').showModal() })
  ;(async () => { try { const boot = await api('bootstrap'); isAdmin = boot.user?.role === 'admin'; $('user').textContent = boot.user?.email || ''; $('admin-actions').hidden = !isAdmin; $('status-filter').hidden = !isAdmin; await refresh(); notify(isAdmin ? '' : 'โหมดอ่านอย่างเดียว — เลือกใช้ Quick Reply ได้จากช่องข้อความใน Inbox') } catch (e) { notify(e.message, true) } })()
})()
