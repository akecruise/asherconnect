/* หน้าเมนู /media-library — ดู/ค้นหา/เพิ่ม/แก้/อนุมัติ/นำออก รูปในคลัง
   ด่านจริงอยู่ที่ inbox.media_* ในฐาน การซ่อนปุ่มตามบทบาทเป็นความสะอาดตาเท่านั้น */
(function () {
  const lib = window.asherImageLibrary
  const $ = id => document.getElementById(id)
  if (!lib) return
  const { api, el } = lib
  const state = { project: '', category: '', q: '', sort: 'recent', scope: 'library' }
  let role = '', rows = [], editing = null
  const editor = () => lib.EDITORS.includes(role)

  function note (text, error = false) { $('notice').hidden = !text; $('notice').textContent = text || ''; $('notice').className = 'notice' + (error ? ' error' : '') }
  const dateInput = iso => iso ? new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10) : ''
  const fmt = iso => iso ? new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' }) : '—'

  async function load () {
    $('grid').replaceChildren(el('div', { class: 'template-empty', text: 'กำลังโหลด…' }))
    try { rows = await api('media_library_list', state) }
    catch (e) { rows = []; $('grid').replaceChildren(el('div', { class: 'template-empty error', text: e.message })); return }
    $('grid').replaceChildren()
    if (!rows.length) $('grid').append(el('div', { class: 'template-empty', text: 'ยังไม่มีรูปที่ตรงกัน' }))
    rows.forEach(a => {
      const meta = el('span', { class: 'media-library-meta', text: `${lib.projectName(a.project)} · ${lib.categoryName(a.category)} · ใช้ ${a.use_count || 0} ครั้ง` })
      const tile = lib.card(a, { extra: meta, onToggle: editor() ? openEditor : null })
      $('grid').append(tile)
    })
  }

  function openEditor (a) {
    editing = a
    $('editor-preview').src = lib.thumbOf(a)
    $('editor-title').value = a.title
    $('editor-project').value = a.project
    $('editor-category').value = a.category
    $('editor-expires').value = dateInput(a.expires_at)
    $('editor-bot').checked = !!a.bot_enabled
    $('editor-approve').hidden = a.status !== 'pending'
    $('editor-meta').textContent = `${a.width || '?'}×${a.height || '?'} px · ${Math.round((a.bytes || 0) / 1024)} KB · เพิ่มเมื่อ ${fmt(a.created_at)} · ใช้ล่าสุด ${fmt(a.last_used_at)}`
    $('editor-error').textContent = ''
    $('editor').showModal()
  }

  async function save (extra = {}) {
    try {
      await api('media_library_update', {
        id: editing.id, title: $('editor-title').value, project: $('editor-project').value, category: $('editor-category').value,
        expires_at: $('editor-expires').value ? new Date($('editor-expires').value + 'T23:59:59+07:00').toISOString() : '',
        bot_enabled: $('editor-bot').checked, ...extra,
      })
      $('editor').close(); note(extra.status === 'approved' ? 'อนุมัติแล้ว รูปขึ้นคลังให้ทีมใช้ได้' : 'บันทึกแล้ว'); load()
    } catch (e) { $('editor-error').textContent = e.message }
  }

  async function start () {
    let boot
    try { boot = await api('bootstrap') } catch { location.replace('/?return_to=' + encodeURIComponent('/media-library')); return }
    role = String(boot?.user?.role || '')
    const reviewer = !!boot?.user?.test_only
    $('add').hidden = reviewer
    $('scope').hidden = !editor()
    $('editor-category').append(...lib.CATEGORIES.slice(1).map(([v, t]) => el('option', { value: v, text: t })))
    $('filters').append(lib.filters(state, load))
    $('add').addEventListener('click', () => {
      const box = $('uploader')
      if (!box.hidden) { box.hidden = true; box.replaceChildren(); return }
      box.hidden = false
      box.replaceChildren(lib.uploadForm({ role, project: state.project, onCancel: () => { box.hidden = true; box.replaceChildren() }, onDone: () => load() }))
    })
    $('scope').addEventListener('click', e => {
      const b = e.target.closest('button[data-scope]'); if (!b) return
      state.scope = b.dataset.scope
      $('scope').querySelectorAll('button').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)) })
      load()
    })
    $('editor-close').addEventListener('click', () => $('editor').close())
    $('editor-form').addEventListener('submit', e => { e.preventDefault(); save() })
    $('editor-approve').addEventListener('click', () => save({ status: 'approved' }))
    $('editor-archive').addEventListener('click', async () => {
      if (!confirm(`นำ “${editing.title}” ออกจากคลัง?\nรูปที่เคยส่งไปแล้วยังอยู่ในแชตตามเดิม`)) return
      try { await api('media_library_archive', { id: editing.id }); $('editor').close(); note('นำออกจากคลังแล้ว'); load() }
      catch (e) { $('editor-error').textContent = e.message }
    })
    load()
  }
  start()
})()
