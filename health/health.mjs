// asher-connect health module.
// No dependencies (Node 18+). Works with a raw http server or Express.
//
//   import { createHealth } from './health/health.mjs';
//   const health = createHealth({ getChannels });
//   health.start();
//   // raw http:  if (await health.handle(req, res)) return;
//   // express:   app.use(health.middleware());
//   // anywhere:  health.log('webhook', { channel: key, ref: eventId });

import fs from 'node:fs/promises';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEVEL_LABEL = { warn: 'ต้องดู', urgent: 'ด่วน' };

export function createHealth(opts = {}) {
  const cfg = {
    supabaseUrl: (opts.supabaseUrl ?? process.env.SUPABASE_URL ?? '').replace(/\/$/, ''),
    anonKey: opts.anonKey ?? process.env.SUPABASE_ANON_KEY,
    serviceKey: opts.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    schema: opts.schema ?? 'inbox',
    publicUrl: (opts.publicUrl ?? process.env.PUBLIC_URL ?? 'https://inbox.apluscondo.com').replace(/\/$/, ''),
    telegramToken: opts.telegramToken ?? process.env.HEALTH_TELEGRAM_TOKEN,
    telegramChatId: opts.telegramChatId ?? process.env.HEALTH_TELEGRAM_CHAT_ID,
    // async () => [{ key: 'naii-line-oa', type: 'line' | 'messenger', accessToken: '...' }]
    getChannels: opts.getChannels ?? (async () => []),
    // async () => ({ overall, database, channels, workers, queue, ... }) — สถานะฝั่งโพรเซส
    // คำนวณที่ server.mjs เพราะอายุ worker/คิว/ช่องทางเป็นของชั้นนั้น; snapshot แค่แนบไปกับคำตอบ
    getSystemStatus: opts.getSystemStatus ?? null,
    // async () => [{ name, ok, ms, detail }] — ข้อทดสอบเพิ่มของชั้นโพรเซส ต่อท้าย self-test
    extraSelfTests: opts.extraSelfTests ?? null,
    tickSeconds: opts.tickSeconds ?? 60,
    slowEveryTicks: opts.slowEveryTicks ?? 60, // TLS + token checks: hourly
    version: opts.version ?? process.env.APP_VERSION ?? null,
  };
  const startedAt = Date.now();
  let timer = null;
  let tickCount = 0;
  let ticking = false;

  // ---- Supabase -------------------------------------------------------------
  async function rpc(fn, body = {}, userToken = null) {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Profile': cfg.schema,
        apikey: userToken ? cfg.anonKey : cfg.serviceKey,
        Authorization: `Bearer ${userToken ?? cfg.serviceKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`rpc ${fn} → ${res.status} ${text.slice(0, 200)}`);
      // สิทธิ์ส่งต่อตรง อินพุตไม่ถูกต้อง (4xx) ก็ส่งต่อตรง — ไม่ยุบเป็น 502 จนคนหน้าจอเข้าใจว่าระบบล่ม
      err.status = res.status === 401 || res.status === 403 ? res.status : res.status < 500 ? 400 : 502;
      if (/forbidden|42501/.test(text)) err.status = 403;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  // Fire-and-forget. Never throws, never blocks a webhook.
  function log(stage, { channel = null, ok = true, ref = null, detail = null } = {}) {
    return rpc('health_log', {
      p_stage: stage,
      p_channel: channel,
      p_ok: ok,
      p_ref: ref == null ? null : String(ref),
      p_detail: detail == null ? null : String(detail),
    }).catch((e) => console.warn('[health] log failed:', e.message));
  }

  // ---- Probes -----------------------------------------------------------------
  async function timed(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      return { name, ok: true, ms: Date.now() - t0, detail: detail ?? null };
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t0, detail: e.message };
    }
  }

  const probeDb = () => timed('ฐานข้อมูล', async () => { await rpc('health_ping'); });

  // Goes out to the public domain and back in through Caddy: DNS + TLS + proxy in one check.
  const probeGateway = () => timed('Gateway (Caddy)', async () => {
    const res = await fetch(`${cfg.publicUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  const probeTls = () => timed('ใบรับรอง TLS', () => new Promise((resolve, reject) => {
    const host = new URL(cfg.publicUrl).hostname;
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert?.valid_to) return reject(new Error('no certificate'));
      resolve(String(Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000)));
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('error', reject);
  }));

  // Asks LINE / Meta whether the access token still works. Sends nothing to customers.
  //
  // ★ Messenger ต้องถามด้วย debug_token ไม่ใช่ /me — token ของเรามีแค่ pages_messaging
  //   ส่วน /me ต้องการ pages_read_engagement จึงตอบ error ทั้งที่ token ยังส่งหาลูกค้าได้ปกติ
  //   = ขึ้นแดงหลอก (เหตุผลเดียวกับ checkToken ใน server.mjs)
  async function probeTokens() {
    const channels = await cfg.getChannels().catch(() => []);
    return Promise.all(channels.filter((c) => c.accessToken).map((c) =>
      timed(`Token ${c.key}`, async () => {
        const res = c.type === 'line'
          ? await fetch('https://api.line.me/v2/bot/info', {
              headers: { Authorization: `Bearer ${c.accessToken}` }, signal: AbortSignal.timeout(8000) })
          : await fetch(`https://graph.facebook.com/v23.0/debug_token?input_token=${encodeURIComponent(c.accessToken)}`, {
              headers: { Authorization: `Bearer ${c.accessToken}` }, signal: AbortSignal.timeout(8000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (c.type !== 'line' && data.data?.is_valid === false) {
          throw new Error(`token ใช้ไม่ได้: ${data.data?.error?.message ?? 'Facebook แจ้งว่าใบนี้ใช้ไม่ได้แล้ว'}`);
        }
        if (data.error) throw new Error(String(data.error.message ?? 'graph error'));
      }).then((r) => ({ ...r, channel: c.key }))));
  }

  async function sendTelegram(text) {
    if (!cfg.telegramToken || !cfg.telegramChatId) return { skipped: true };
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await log('telegram', { ok: true });
      return { ok: true };
    } catch (e) {
      await log('telegram', { ok: false, detail: e.message });
      return { ok: false, detail: e.message };
    }
  }

  // ---- Checker loop -------------------------------------------------------------
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const gw = await probeGateway();
      await log('gateway', { ok: gw.ok, detail: gw.ok ? `${gw.ms}ms` : gw.detail });

      if (tickCount % cfg.slowEveryTicks === 0) {
        const cert = await probeTls();
        await log('tls', { ok: cert.ok, detail: cert.detail });
        for (const t of await probeTokens()) {
          await log('token', { channel: t.channel, ok: t.ok, detail: t.ok ? null : t.detail });
        }
      }
      tickCount++;

      const changes = (await rpc('health_tick')) ?? [];
      for (const c of changes.filter((x) => x.notify)) {
        await sendTelegram(c.firing
          ? `[${LEVEL_LABEL[c.level] ?? c.level}] ${c.name}\n${c.value ?? ''}\n${cfg.publicUrl}/admin/health`
          : `[กลับมาปกติ] ${c.name}`);
      }
    } catch (e) {
      console.warn('[health] tick failed:', e.message);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    setTimeout(tick, 5000);
    timer = setInterval(tick, cfg.tickSeconds * 1000);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  // ---- HTTP -----------------------------------------------------------------------
  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function readJson(req) {
    if (req.body && typeof req.body === 'object') return req.body; // express.json() already ran
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  function bearer(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw Object.assign(new Error('missing token'), { status: 401 });
    return m[1];
  }

  async function selftest() {
    const steps = [await probeGateway(), await probeDb(), await probeTls(), ...(await probeTokens())];
    const t0 = Date.now();
    const tg = await sendTelegram('ทดสอบระบบจากหน้าสถานะระบบ: ถ้าเห็นข้อความนี้ การแจ้งเตือนทำงานปกติ');
    steps.push({ name: 'Telegram', ok: tg.ok === true, ms: Date.now() - t0,
                 detail: tg.skipped ? 'ยังไม่ได้ตั้งค่า token/chat id (ข้าม)' : tg.detail ?? null });
    // ข้อทดสอบของชั้นโพรเซส (worker/คิว/ตัวแปรที่จำเป็น) — ต่อท้ายให้ปุ่มเดียวเห็นครบ
    if (cfg.extraSelfTests) {
      try { for (const t of await cfg.extraSelfTests()) {
        steps.push({ name: t.name, ok: t.ok === true, ms: t.ms ?? 0, detail: t.detail ?? null });
      } } catch { /* ของแถมพังไม่ควรพาตัวหลักล้ม */ }
    }
    const failed = steps.filter((s) => !s.ok);
    await log('selftest', {
      ok: failed.length === 0,
      detail: failed.length ? `ไม่ผ่าน: ${failed.map((s) => s.name).join(', ')}`
                            : `ผ่านครบ ${steps.length} ขั้น`,
    });
    return steps;
  }

  // Returns true when the request was one of ours.
  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && pathname === '/healthz') {
        const db = await probeDb();
        send(res, db.ok ? 200 : 503, { ok: db.ok, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
        return true;
      }
      if (req.method === 'GET' && pathname === '/admin/health') {
        send(res, 200, await fs.readFile(path.join(HERE, 'health.html'), 'utf8'), 'text/html; charset=utf-8');
        return true;
      }
      if (!pathname.startsWith('/api/health/')) return false;

      if (req.method === 'POST' && pathname === '/api/health/login') {
        const { email, password } = await readJson(req);
        const r = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey },
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return send(res, 401, { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }), true;
        const { access_token, expires_in } = await r.json();
        return send(res, 200, { access_token, expires_in }), true;
      }

      if (req.method === 'GET' && pathname === '/api/health/snapshot') {
        const snap = await rpc('health_snapshot', {}, bearer(req));
        const db = await probeDb();
        snap.app = { uptime_s: Math.round((Date.now() - startedAt) / 1000), version: cfg.version,
                     db_ms: db.ok ? db.ms : null, telegram_configured: Boolean(cfg.telegramToken && cfg.telegramChatId) };
        // สถานะฝั่งโพรเซส (overall/database/workers/queue/channels) คำนวณที่ server.mjs — แนบตามไป
        if (cfg.getSystemStatus) {
          try { snap.system = await cfg.getSystemStatus(); } catch { snap.system = null; }
        }
        return send(res, 200, snap), true;
      }

      if (req.method === 'POST' && pathname === '/api/health/rule') {
        const b = await readJson(req);
        await rpc('health_rule_save', {
          p_id: b.id, p_enabled: b.enabled ?? null, p_params: b.params ?? null, p_level: b.level ?? null,
          p_notify: b.notify ?? null, p_hour_from: b.hour_from ?? null, p_hour_to: b.hour_to ?? null,
        }, bearer(req));
        await rpc('health_tick');
        return send(res, 200, { ok: true }), true;
      }

      if (req.method === 'POST' && pathname === '/api/health/selftest') {
        if (!(await rpc('health_can_view', {}, bearer(req)))) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
        return send(res, 200, { steps: await selftest() }), true;
      }

      return send(res, 404, { error: 'not found' }), true;
    } catch (e) {
      const status = e.status ?? 500;
      const msg = status === 401 ? 'กรุณาเข้าสู่ระบบใหม่'
                : status === 403 ? 'หน้านี้สำหรับ manager และ admin'
                : 'ระบบตรวจสอบมีปัญหา: ' + e.message;
      send(res, status, { error: msg });
      return true;
    }
  }

  const middleware = () => (req, res, next) => {
    handle(req, res).then((done) => { if (!done) next(); }).catch(next);
  };

  return { log, start, stop, tick, handle, middleware, selftest };
}
