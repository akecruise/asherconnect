(() => {
  const button = document.getElementById('media-library')
  const menu = document.getElementById('media-library-menu')
  if (!button || !menu) return
  const el = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = value; if (cls) node.className = cls; return node }
  const imageUrl = value => { const text = String(value || '').trim(); return /^https:\/\//i.test(text) || /^\/(?!\/)/.test(text) ? text : '' }
  const close = () => { menu.hidden = true; menu.replaceChildren() }
  const open = async () => {
    if (!menu.hidden) return close()
    menu.hidden = false; menu.replaceChildren(el('strong', 'คลังรูป A9'), el('span', 'กำลังโหลดภาพจริง…', 'media-library-status'))
    try {
      const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'quick_replies_list', data: {} }) })
      if (!response.ok) throw new Error('โหลดคลังรูปไม่สำเร็จ')
      const payload = await response.json()
      const rows = Array.isArray(payload) ? payload : (payload.quick_replies || payload.items || [])
      const images = rows.flatMap(row => [row.image_url, ...(row.attachments || []).flatMap(asset => [asset.public_url, asset.preview_url])]).map(imageUrl).filter(Boolean).filter((url, i, all) => all.indexOf(url) === i)
      menu.replaceChildren(el('strong', 'คลังรูป A9'))
      if (!images.length) { menu.append(el('span', 'ยังไม่พบรูปจริงใน Quick Reply A9', 'media-library-status')); return }
      const grid = el('div', null, 'media-library-grid')
      images.forEach(url => { const item = el('button', null, 'media-library-item'); item.type = 'button'; const image = document.createElement('img'); image.src = url; image.alt = 'รูปจากคลัง A9'; image.loading = 'lazy'; item.append(image); item.addEventListener('click', async () => { item.disabled = true; try { await window.asherSendImage?.(url); close() } finally { item.disabled = false } }); grid.append(item) })
      menu.append(grid)
    } catch (error) { menu.replaceChildren(el('strong', 'คลังรูป A9'), el('span', error.message, 'media-library-status')) }
  }
  button.addEventListener('click', open)
  document.addEventListener('click', event => { if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close() })
})()
