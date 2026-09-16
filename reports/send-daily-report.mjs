#!/usr/bin/env node
// =====================================================================
// รายงานสรุปการตอบรายวัน -> Telegram
// รันจาก cron ของเครื่อง (ไม่ใช้ pg_net) เพราะ token อยู่ใน channels.json
// โดยเจตนา จะได้ไม่ติดไปกับ backup ของฐานข้อมูล
//
//   node scripts/send-daily-report.mjs            # เมื่อวาน
//   node scripts/send-daily-report.mjs 2026-09-01 # ระบุวัน
// =====================================================================
import { readFile } from "node:fs/promises";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHANNELS     = process.env.CHANNELS_FILE ?? "./channels.json";

async function rpc(action, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "inbox",
      "Accept-Profile": "inbox",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`${action} ${res.status}: ${await res.text()}`);
  return res.json();
}

const date = process.argv[2] ??
  new Date(Date.now() - 864e5).toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });

// รวมยอดก่อน แล้วค่อยดึงข้อความรายงาน (rollup เป็น idempotent รันซ้ำได้)
await rpc("rollup_agent_daily", { p_date: date });
const text = await rpc("stats_telegram_daily", { p_date: date });

const channels = JSON.parse(await readFile(CHANNELS, "utf8"));
const tg = channels.telegram_report ?? channels.telegram;
if (!tg?.bot_token || !tg?.chat_id) {
  throw new Error("channels.json: ต้องมี telegram_report { bot_token, chat_id }");
}

const send = await fetch(`https://api.telegram.org/bot${tg.bot_token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: tg.chat_id, text, disable_web_page_preview: true }),
});

if (!send.ok) throw new Error(`telegram ${send.status}: ${await send.text()}`);
console.log(`[report] ส่งสรุปของวัน ${date} เรียบร้อย`);
