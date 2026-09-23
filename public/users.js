const $ = id => document.getElementById(id)
const fmt = value => value ? new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
const roleName = { sales: 'Sales', senior_sales: 'Sales', manager: 'Manager', admin: 'Admin' }
const el = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = value; if (cls) node.className = cls; return node }

export function mountUsers({ role, actorId }) {
  document.body.classList.add('admin-view', 'users-view')
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/users.css' }))
  const main = document.querySelector('#workspace main')
  const view = el('section', null, 'users-page')
  view.innerHTML = `<header class="users-head"><div><h1>ผู้ใช้และสิทธิ์</h1><p>จัดการบัญชีเดียวสำหรับ ASHER Connect และ ASHER CRM</p></div><div class="users-head-actions"><a id="users-return" href="/" class="users-back">กลับ</a><button id="users-add" type="button">เพิ่มผู้ใช้</button></div></header>
  <div class="users-filters"><label>ค้นหา<input id="users-search" type="search" placeholder="ชื่อ อีเมล หรือทีม"></label><label>สถานะ<select id="users-status"><option value="">ทั้งหมด</option><option value="active">Active</option><option value="disabled">Disabled</option></select></label><label>Role<select id="users-role"><option value="">ทั้งหมด</option><option value="sales">Sales</option><option value="senior_sales">Senior Sales</option><option value="manager">Manager</option><option value="admin">Admin</option></select></label><label>Module<select id="users-module"><option value="">ทั้งหมด</option><option value="connect">Connect</option><option value="crm">CRM</option></select></label></div>
  <p id="users-message" role="status">กำลังโหลดผู้ใช้…</p><div class="users-table-wrap"><table><thead><tr><th>ชื่อ</th><th>Username / login</th><th>Role</th><th>Team</th><th>Connect</th><th>CRM</th><th>สถานะ</th><th>Last sign-in</th><th>Updated</th><th>Actions</th></tr></thead><tbody id="users-rows"></tbody></table></div><nav class="users-pages" aria-label="หน้ารายชื่อ"><button id="users-prev" type="button">ก่อนหน้า</button><span id="users-page-num"></span><button id="users-next" type="button">ถัดไป</button></nav>
  <dialog id="users-dialog"><form id="users-form"><h2 id="users-dialog-title">เพิ่มผู้ใช้</h2><label>ชื่อที่แสดง<input name="display_name" required maxlength="200"></label><label>Username / login email<input name="email" type="email" required maxlength="254" placeholder="name@asher.local"></label><label>Role<select name="role"><option value="sales">Sales</option><option value="senior_sales">Senior Sales</option><option value="manager">Manager</option><option value="admin">Admin</option></select></label><label>Team<input name="team" maxlength="100"></label><fieldset><legend>Module access</legend><label><input type="checkbox" name="connect"> Connect</label><label><input type="checkbox" name="crm"> CRM</label></fieldset><label><input type="checkbox" name="is_active" checked> Active</label><div class="users-dialog-actions"><button type="button" data-cancel>ยกเลิก</button><button type="submit">บันทึก</button></div><p id="users-form-error" role="alert"></p></form></dialog>
  <dialog id="users-password-dialog"><form id="users-password-form"><h2>ตั้งรหัสผ่านใหม่</h2><label>รหัสผ่านใหม่<input name="password" type="password" autocomplete="new-password" minlength="12"></label><label>กรอกอีกครั้ง<input name="confirm_password" type="password" autocomplete="new-password" minlength="12"></label><label><input type="checkbox" id="users-show-password"> แสดงรหัสผ่าน</label><div class="users-dialog-actions"><button type="button" data-cancel>ยกเลิก</button><button type="submit">ตั้งรหัสผ่าน</button></div><p id="users-password-error" role="alert"></p></form></dialog>
  <dialog id="users-result-dialog"><h2 id="users-result-title"></h2><p id="users-result-text"></p><code id="users-temp-password"></code><div class="users-dialog-actions"><button id="users-copy" type="button">คัดลอก</button><button type="button" data-cancel>ปิด</button></div></dialog>
  <dialog id="users-audit-dialog"><h2>ประวัติการจัดการผู้ใช้</h2><div id="users-audit-list"></div><button type="button" data-cancel>ปิด</button></dialog>`
  main.append(view)
  try { const back = new URL(new URLSearchParams(location.search).get('return_to')); if (back.origin === 'https://crm.apluscondo.com') $('users-return').href = back.href } catch {}
  if (role !== 'admin') { $('users-message').textContent = 'หน้านี้สำหรับผู้ดูแลระบบเท่านั้น'; $('users-add').hidden = true; return }
  let page = 1, total = 0, users = [], editing = null, resetTarget = null, debounce
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(({ not_allowed: 'ไม่มีสิทธิ์จัดการผู้ใช้', invalid_user: 'ข้อมูลผู้ใช้ไม่ถูกต้อง',
      duplicate_login: 'อีเมลนี้มีบัญชีอยู่แล้ว', password_mismatch: 'รหัสผ่านสองช่องไม่ตรงกัน',
      weak_password: 'รหัสผ่านต้องยาวอย่างน้อย 12 ตัว มีตัวอักษรและตัวเลข',
      self_admin_change: 'ปิดหรือลดสิทธิ์บัญชีผู้ดูแลของตนเองไม่ได้', last_admin: 'ต้องมีผู้ดูแลระบบอย่างน้อยหนึ่งคน' })[data.error] ?? 'ทำรายการไม่สำเร็จ กรุณาลองใหม่')
    return data
  }
  const filters = () => new URLSearchParams({ page: String(page), page_size: '20', q: $('users-search').value,
    status: $('users-status').value, role: $('users-role').value, module: $('users-module').value })
  async function load() {
    $('users-message').textContent = 'กำลังโหลดผู้ใช้…'
    try {
      const result = await api(`/api/admin/users?${filters()}`)
      users = result.users; total = result.total
      const rows = $('users-rows'); rows.replaceChildren()
      for (const u of users) {
        const tr = document.createElement('tr')
        for (const value of [u.display_name, u.email, roleName[u.role] ?? 'ยังไม่กำหนด', u.team || '—',
          u.modules.includes('connect') ? '✓' : '—', u.modules.includes('crm') ? '✓' : '—',
          u.is_active ? 'Active' : 'Disabled', fmt(u.last_sign_in_at), fmt(u.updated_at)]) tr.append(el('td', value))
        const actions = el('td', null, 'users-actions')
        for (const [label, action] of (u.provisioned === false ? [['กำหนดสิทธิ์', 'edit']] : [['แก้ไข', 'edit'], ['รหัสผ่าน', 'password'], ['ชั่วคราว', 'temporary'],
          [u.is_active ? 'ปิดบัญชี' : 'เปิดบัญชี', 'toggle'], ['ออกจากระบบ', 'revoke'], ['ประวัติ', 'audit']])) {
          const button = el('button', label); button.type = 'button'; button.dataset.action = action; button.dataset.id = u.id
          actions.append(button)
        }
        tr.append(actions); rows.append(tr)
      }
      $('users-message').textContent = total ? `${total} บัญชี` : 'ไม่พบผู้ใช้ตามเงื่อนไข'
      $('users-page-num').textContent = `หน้า ${page} / ${Math.max(1, Math.ceil(total / 20))}`
      $('users-prev').disabled = page <= 1; $('users-next').disabled = page * 20 >= total
    } catch (e) { $('users-message').textContent = `โหลดไม่สำเร็จ: ${e.message}` }
  }
  function showTemp(value, title = 'รหัสผ่านชั่วคราว') {
    $('users-result-title').textContent = title
    $('users-result-text').textContent = 'แสดงครั้งเดียว กรุณาคัดลอกและส่งให้ผู้ใช้ผ่านช่องทางที่ปลอดภัย'
    $('users-temp-password').textContent = value
    $('users-result-dialog').showModal()
  }
  function edit(user) {
    editing = user?.id ?? null
    $('users-dialog-title').textContent = user ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้'
    const form = $('users-form'); form.reset()
    for (const key of ['display_name', 'email', 'role', 'team']) form.elements[key].value = user?.[key] ?? (key === 'role' ? 'sales' : '')
    for (const key of ['connect', 'crm']) form.elements[key].checked = user ? user.modules.includes(key) : true
    form.elements.is_active.checked = user?.is_active ?? true
    $('users-form-error').textContent = ''
    $('users-dialog').showModal()
  }
  $('users-add').onclick = () => edit(null)
  $('users-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget
    const data = Object.fromEntries(new FormData(form))
    const body = { display_name: data.display_name, email: data.email, role: data.role, team: data.team,
      modules: ['connect', 'crm'].filter(m => form.elements[m].checked), is_active: form.elements.is_active.checked }
    try {
      const result = await api(editing ? `/api/admin/users/${editing}` : '/api/admin/users', editing ? 'PATCH' : 'POST', body)
      $('users-dialog').close(); await load()
      if (result.temporary_password) showTemp(result.temporary_password)
    } catch (e) { $('users-form-error').textContent = e.message }
  }
  $('users-rows').onclick = async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return
    const user = users.find(u => u.id === button.dataset.id); if (!user) return
    try {
      if (button.dataset.action === 'edit') return edit(user)
      if (button.dataset.action === 'password') { resetTarget = user.id; $('users-password-form').reset(); $('users-password-error').textContent = ''; $('users-password-dialog').showModal(); return }
      if (button.dataset.action === 'temporary') { if (!confirm(`สร้างรหัสผ่านชั่วคราวใหม่ให้ ${user.email}?`)) return; const result = await api(`/api/admin/users/${user.id}/reset-password`, 'POST', { generate: true }); showTemp(result.temporary_password); return }
      if (button.dataset.action === 'toggle') { if (!confirm(`${user.is_active ? 'ปิด' : 'เปิด'}บัญชี ${user.email}?`)) return; await api(`/api/admin/users/${user.id}/${user.is_active ? 'disable' : 'enable'}`, 'POST', {}); await load(); return }
      if (button.dataset.action === 'revoke') { if (!confirm(`บังคับให้ ${user.email} เข้าสู่ระบบใหม่?`)) return; await api(`/api/admin/users/${user.id}/revoke-sessions`, 'POST', {}); $('users-message').textContent = 'เพิกถอน session แล้ว'; return }
      if (button.dataset.action === 'audit') { const history = await api(`/api/admin/users/${user.id}/audit`); const root = $('users-audit-list'); root.replaceChildren(...history.map(item => el('p', `${fmt(item.created_at)} · ${item.action} · ${item.actor_id}`))); if (!history.length) root.textContent = 'ยังไม่มีประวัติ'; $('users-audit-dialog').showModal() }
    } catch (e) { $('users-message').textContent = e.message }
  }
  $('users-password-form').onsubmit = async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget))
    try { await api(`/api/admin/users/${resetTarget}/reset-password`, 'POST', data); $('users-password-dialog').close(); $('users-message').textContent = 'ตั้งรหัสผ่านใหม่แล้ว' }
    catch (e) { $('users-password-error').textContent = e.message }
  }
  $('users-show-password').onchange = event => { for (const name of ['password', 'confirm_password']) $('users-password-form').elements[name].type = event.target.checked ? 'text' : 'password' }
  $('users-copy').onclick = async () => { await navigator.clipboard.writeText($('users-temp-password').textContent); $('users-copy').textContent = 'คัดลอกแล้ว' }
  view.querySelectorAll('[data-cancel]').forEach(button => button.onclick = () => button.closest('dialog').close())
  $('users-result-dialog').addEventListener('close', () => { $('users-temp-password').textContent = ''; $('users-copy').textContent = 'คัดลอก' })
  for (const id of ['users-search', 'users-status', 'users-role', 'users-module']) $(id).oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => { page = 1; void load() }, 250) }
  $('users-prev').onclick = () => { page--; void load() }
  $('users-next').onclick = () => { page++; void load() }
  void load()
}
