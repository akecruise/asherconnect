// หน้า /admin/health — แยกออกจาก health/health.html เพราะ CSP อนุญาตแค่สคริปต์จาก self
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LEVEL = { ok: 'ปกติ', warn: 'ต้องดู', urgent: 'ด่วน', idle: 'ยังไม่มีข้อมูล' };
let token = null;
try { token = sessionStorage.getItem('health_token'); } catch {}
let snap = null;

async function api(path, body) {
  const res = await fetch('/api/health/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error(data.error || 'กรุณาเข้าสู่ระบบ'); }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function showLogin() {
  token = null;
  try { sessionStorage.removeItem('health_token'); } catch {}
  $('app').hidden = true; $('login').hidden = false;
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const r = await api('login', { email: $('email').value, password: $('password').value });
    token = r.access_token;
    try { sessionStorage.setItem('health_token', token); } catch {}
    $('login').hidden = true;
    await refresh();
  } catch (err) { $('loginErr').textContent = err.message; }
});

function ago(iso) {
  if (!iso) return 'ยังไม่มี';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return m + ' นาทีที่แล้ว';
  if (m < 1440) return Math.floor(m / 60) + ' ชม. ที่แล้ว';
  return Math.floor(m / 1440) + ' วันที่แล้ว';
}
const clock = (iso) => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
function uptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} วัน ${h} ชม.` : h ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
// ป้ายสถานะรวม — คำนวณที่ backend (server.mjs) หน้านี้แค่แปลงเป็นสีกับคำ
const OVERALL = { healthy: ['ok', 'HEALTHY'], degraded: ['warn', 'DEGRADED'], down: ['urgent', 'DOWN'], unknown: ['idle', 'UNKNOWN'] };
const OPS_TAG = { healthy: 'ok', degraded: 'warn', down: 'urgent', unknown: 'idle', disabled: 'idle', warn: 'warn' };
const OPS_LABEL = { healthy: 'ปกติ', degraded: 'ต้องดู', down: 'ล่ม', unknown: 'ยังไม่มีข้อมูล', disabled: 'ปิดอยู่', warn: 'ต้องดู' };

function opsCard(title, key, status, rows) {
  return `<div class="node"><header><h3>${esc(title)}</h3><span class="tag ${OPS_TAG[status] ?? 'idle'}">${OPS_LABEL[status] ?? esc(status)}</span></header>
    <div class="key">${esc(key)}</div>
    ${rows.map(([k, v, bad]) => `<div class="row"><span>${esc(k)}</span><span class="num ${bad ? 'bad' : ''}">${esc(v)}</span></div>`).join('')}
  </div>`;
}
function stat(stage, channel) {
  const out = { last_at: null, last_ok: null, n_1h: 0, fail_1h: 0, fail_24h: 0 };
  for (const s of snap.stats) {
    if (s.stage !== stage || (channel !== undefined && s.channel !== channel)) continue;
    out.last_at = later(out.last_at, s.last_at); out.last_ok = later(out.last_ok, s.last_ok);
    out.n_1h += s.n_1h; out.fail_1h += s.fail_1h; out.fail_24h += s.fail_24h;
  }
  return out;
}

function nodeHtml(id, title, key, rows, hasData) {
  const firing = snap.rules.filter((r) => r.node === id && r.enabled && r.firing);
  const level = firing.some((r) => r.level === 'urgent') ? 'urgent' : firing.length ? 'warn' : hasData ? 'ok' : 'idle';
  return `<div class="node"><header><h3>${esc(title)}</h3><span class="tag ${level}">${LEVEL[level]}</span></header>
    <div class="key">${esc(key)}</div>
    ${rows.map(([k, v, bad]) => `<div class="row"><span>${esc(k)}</span><span class="num ${bad ? 'bad' : ''}">${esc(v)}</span></div>`).join('')}
    ${firing.map((r) => `<div class="why is-${r.level}">${esc(r.name)}: ${esc(r.value)}</div>`).join('')}
  </div>`;
}

function render() {
  const channels = [...new Set([
    ...snap.stats.filter((s) => s.stage === 'webhook' && s.channel).map((s) => s.channel),
    ...snap.rules.filter((r) => r.node.startsWith('in:')).map((r) => r.node.slice(3)),
  ])].sort();

  const inbound = channels.map((ch) => {
    const w = stat('webhook', ch), sig = stat('signature_fail', ch);
    return nodeHtml('in:' + ch, ch.includes('messenger') ? 'Messenger' : 'LINE', ch, [
      ['ล่าสุด', ago(w.last_ok)], ['1 ชม.', w.n_1h + ' ข้อความ'],
      ['Signature ไม่ผ่าน', sig.fail_1h, sig.fail_1h > 0],
    ], Boolean(w.last_at));
  }).join('') || '<div class="node"><div class="key">ยังไม่มี webhook เข้ามา เพิ่ม health.log(\'webhook\') ใน server.mjs</div></div>';

  const gw = stat('gateway'), rpcS = stat('rpc'), sigAll = stat('signature_fail');
  const sys = snap.system;
  const w = sys?.workers, q = sys?.queue;
  // ส่วนประมวลผล: worker สองคิว · คิวงาน · โหมดเงา — ตัวเลขจริงจาก backend ทั้งหมด
  const ops = [
    opsCard('Inbound Worker', 'ดึงของดิบจากคิวมาบันทึกข้อความ', w?.inbound?.status ?? 'unknown', [
      ['สำเร็จล่าสุด', w?.inbound?.lastSuccessAt ? ago(w.inbound.lastSuccessAt) : 'ยังไม่ได้'],
      ['อายุ', (w?.inbound?.ageMin ?? '—') + ' นาที'],
      ['เกณฑ์เตือน/วิกฤต', `${w?.inbound?.warnMin ?? '—'} / ${w?.inbound?.critMin ?? '—'} นาที`],
    ]),
    opsCard('Bot / Outbound Worker', 'ตอบกลับและส่งข้อความออก', w?.outbound?.status ?? 'unknown', [
      ['สำเร็จล่าสุด', w?.outbound?.lastSuccessAt ? ago(w.outbound.lastSuccessAt) : 'ยังไม่ได้'],
      ['โหมด', w?.outbound?.shadow ? 'เงา — ตั้งใจไม่ส่ง จึงไม่นับว่าเงียบ' : 'ส่งจริง'],
      ['เกณฑ์เตือน/วิกฤต', `${w?.outbound?.warnMin ?? '—'} / ${w?.outbound?.critMin ?? '—'} นาที`],
    ]),
    opsCard('Queue', 'คิวงานของ worker (connect_private.job)', q?.status ?? 'unknown', [
      ['Pending', q?.pending ?? '—'], ['Processing', q?.processing ?? '—'], ['Failed', q?.failed ?? '—', Number(q?.failed) > 0],
      ['เก่าสุด', q?.oldest_min != null ? q.oldest_min + ' นาที' : '—'],
    ]),
    opsCard('Shadow Mode', 'สวิตช์ส่งจริงของทั้งระบบ', 'healthy', [
      ['สถานะ', sys?.shadowMode ? 'ON' : 'OFF'],
      ['ความหมาย', sys?.shadowMode ? 'รับข้อความเข้าอย่างเดียว — ห้ามส่งออกหาลูกค้า' : 'ส่งข้อความหาลูกค้าจริง'],
    ]),
  ];
  $('ops').innerHTML = ops.join('');
  // สถานะรวมมาจาก backend เท่านั้น — ตัวนับกฎด้านล่างเป็นข้อมูลประกอบ
  const ov = OVERALL[sys?.overall ?? 'unknown'] ?? OVERALL.unknown;
  $('overall').className = 'tag big ' + ov[0];
  $('overall').textContent = ov[1];
  $('sysmeta').textContent = `ทำงานมา ${uptime(sys?.uptimeSec ?? snap.app.uptime_s)} · เวอร์ชัน ${sys?.version || '—'} · ${sys?.environment ?? '—'}`;
  const sent = stat('reply_sent'), tg = stat('telegram'), tok = snap.stats.filter((s) => s.stage === 'token');
  const badTok = tok.filter((t) => t.last_at !== t.last_ok).map((t) => t.channel);
  const p = snap.pending || { n: 0 };
  const ws = Object.entries(snap.workspace || {});

  const cols = [
    ['ช่องทางขาเข้า', inbound],
    ['Gateway', nodeHtml('gateway', 'Caddy', location.host, [
      ['ตรวจผ่านล่าสุด', ago(gw.last_ok)], ['เข้าไม่ได้ใน 1 ชม.', gw.fail_1h, gw.fail_1h > 0],
      ['TLS หมดอายุ', snap.tls_days == null ? 'ยังไม่ได้ตรวจ' : 'อีก ' + snap.tls_days + ' วัน'],
    ], Boolean(gw.last_at))],
    ['แอป', nodeHtml('app', 'asher-connect', snap.app.version ? 'เวอร์ชัน ' + snap.app.version : '/webhooks/<key>', [
      ['ทำงานต่อเนื่อง', uptime(snap.app.uptime_s)], ['Signature ไม่ผ่าน 1 ชม.', sigAll.fail_1h, sigAll.fail_1h > 0],
    ], true)],
    ['ฐานข้อมูล', nodeHtml('db', 'Postgres', 'schema inbox', [
      ['ตอบกลับใน', snap.app.db_ms == null ? 'ไม่ตอบ' : snap.app.db_ms + ' ms', snap.app.db_ms == null],
      ['บันทึกล่าสุด', ago(rpcS.last_ok)], ['บันทึกไม่สำเร็จ 1 ชม.', rpcS.fail_1h, rpcS.fail_1h > 0],
    ], true)],
    ['ขาออก',
      nodeHtml('out:bot', 'บอทตอบกลับ', 'ส่งผ่าน LINE / Meta API', [
        ['คิวค้าง', p.n ? `${p.n} · นานสุด ${p.oldest_min} นาที` : 'ไม่มี', p.n > 0],
        ['ส่งสำเร็จ 1 ชม.', `${sent.n_1h - sent.fail_1h} / ${sent.n_1h}`, sent.fail_1h > 0],
        ['Token', !tok.length ? 'ยังไม่ได้ตรวจ' : badTok.length ? 'ใช้ไม่ได้: ' + badTok.join(', ') : 'ใช้ได้ทุกช่องทาง', badTok.length > 0],
      ], Boolean(sent.last_at || tok.length)) +
      nodeHtml('out:workspace', 'Sales Workspace', 'ทีมขายตอบเคส',
        ws.length ? ws.map(([k, v]) => [k, v]) : [['ข้อมูล', 'ยังไม่ได้ต่อ (health_workspace)']], ws.length > 0) +
      nodeHtml('out:telegram', 'Telegram', 'แจ้งเตือนและรายงาน', [
        ['ส่งล่าสุด', snap.app.telegram_configured ? ago(tg.last_ok) : 'ยังไม่ได้ตั้งค่า'],
        ['ล้มเหลว 24 ชม.', tg.fail_24h, tg.fail_24h > 0],
      ], Boolean(tg.last_at))],
  ];
  $('flow').innerHTML = cols.map(([h, body]) => `<div class="col"><h2>${esc(h)}</h2>${body}</div>`).join('');

  const firing = snap.rules.filter((r) => r.enabled && r.firing);
  $('updated').textContent = 'อัปเดต ' + new Date(snap.now).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' }) +
    (firing.length ? ` · กฎยิง ${firing.length} เรื่อง` : '');

  renderRules();
  $('events').innerHTML = snap.events.length
    ? snap.events.map((e) => `<div class="ev ${e.ok ? '' : 'bad'}"><time class="num">${clock(e.at)}</time>
        <span>${esc(e.stage === 'alert' || e.stage === 'selftest' ? e.detail : [e.stage, e.channel, e.detail].filter(Boolean).join(' · '))}</span></div>`).join('')
    : '<div class="empty">ยังไม่มีเหตุการณ์ผิดปกติ</div>';
}

const MAIN_PARAM = { silence: ['minutes', 'นาที'], fail_count: ['threshold', 'ครั้ง'], pending_age: ['minutes', 'นาที'], tls_days: ['days', 'วัน'], worker_age: ['minutes', 'นาที'] };

function renderRules() {
  if (document.activeElement && $('rules').contains(document.activeElement)) return; // don't fight the editor
  const ro = snap.can_edit ? '' : 'disabled';
  $('rules').innerHTML = snap.rules.map((r) => {
    const [pk, unit] = MAIN_PARAM[r.kind];
    const win = r.kind === 'fail_count' ? `ใน ${r.params.minutes} นาที` : '';
    return `<div class="rule ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
      <input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''} ${ro} aria-label="เปิดใช้กฎ ${esc(r.name)}">
      <span>${esc(r.name)}</span>
      <span class="tag ${r.firing && r.enabled ? r.level : 'idle'}">${r.firing && r.enabled ? LEVEL[r.level] : esc(r.value || 'ปกติ')}</span>
      <div class="ctl">
        <label>เกิน <input type="number" min="1" data-f="param" data-k="${pk}" value="${esc(r.params[pk])}" ${ro}> ${unit} ${win}</label>
        <label>ระดับ <select data-f="level" ${ro}><option value="warn" ${r.level === 'warn' ? 'selected' : ''}>ต้องดู</option><option value="urgent" ${r.level === 'urgent' ? 'selected' : ''}>ด่วน</option></select></label>
        <label><input type="checkbox" data-f="notify" ${r.notify ? 'checked' : ''} ${ro}> แจ้ง Telegram</label>
        <span class="num">${String(r.hour_from).padStart(2, '0')}:00–${String(r.hour_to).padStart(2, '0')}:00</span>
      </div></div>`;
  }).join('') + (snap.can_edit ? '' : '<div class="empty">เฉพาะ admin แก้กฎได้</div>');
}

$('rules').addEventListener('change', async (e) => {
  const el = e.target, id = el.closest('.rule')?.dataset.id;
  if (!id) return;
  const body = { id };
  if (el.dataset.f === 'enabled') body.enabled = el.checked;
  if (el.dataset.f === 'notify') body.notify = el.checked;
  if (el.dataset.f === 'level') body.level = el.value;
  if (el.dataset.f === 'param') {
    const n = parseInt(el.value, 10);
    if (!(n >= 1)) { $('pageErr').textContent = 'ใส่ตัวเลขตั้งแต่ 1 ขึ้นไป'; return; }
    body.params = { [el.dataset.k]: n };
  }
  try { await api('rule', body); el.blur(); $('pageErr').textContent = ''; await refresh(); }
  catch (err) { $('pageErr').textContent = 'บันทึกกฎไม่สำเร็จ: ' + err.message; }
});

$('testBtn').addEventListener('click', async () => {
  const btn = $('testBtn');
  btn.disabled = true; btn.textContent = 'กำลังตรวจ…';
  try {
    const { steps } = await api('selftest', {});
    $('test').hidden = false;
    $('test').innerHTML = steps.map((s) => `<div class="ev ${s.ok ? '' : 'bad'}">
      <span class="tag ${s.ok ? 'ok' : 'urgent'}">${s.ok ? 'ผ่าน' : 'ไม่ผ่าน'}</span><span>${esc(s.name)}${s.ok || !s.detail ? '' : ' · ' + esc(s.detail)}</span>
      <span class="num">${s.ms} ms</span></div>`).join('');
    await refresh();
  } catch (err) { $('pageErr').textContent = 'ตรวจไม่สำเร็จ: ' + err.message; }
  finally { btn.disabled = false; btn.textContent = 'ตรวจทุกขั้นตอนนี้'; }
});

async function refresh() {
  if (!token) return showLogin();
  try {
    snap = await api('snapshot');
    $('app').hidden = false; $('login').hidden = true; $('pageErr').textContent = '';
    render();
  } catch (err) {
    if (token) { $('app').hidden = false; $('pageErr').textContent = err.message; }
  }
}

$('refreshBtn').addEventListener('click', async () => {
  $('refreshBtn').disabled = true;
  try { await refresh(); } finally { $('refreshBtn').disabled = false; }
});

refresh();
setInterval(() => { if (token && !document.hidden) refresh(); }, 30000);
