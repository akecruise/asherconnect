# Handoff: ระบบเช็คสถานะสำหรับ admin (2026-09-17)

ติดตั้งชุด health check ที่ได้รับมาเป็นโค้ดจริง (3 ไฟล์) ลงใน asher-connect ครบแล้ว
บันทึกนี้สรุปว่าอะไรอยู่ที่ไหน อะไรต่างจากที่ README ของชุดเดิมเขียนไว้ และเหลืออะไรให้ทำบน VPS

## ของที่ลง repo แล้ว

| ไฟล์ | ที่มา |
|---|---|
| `health/health.mjs` | ไฟล์ที่ได้รับมา — แก้จุดเดียว: ถาม token ของ Messenger ด้วย `debug_token` ไม่ใช่ `/me` (เหตุผลเดียวกับ `checkToken` เดิมใน server.mjs — ไม่งั้นกฎ token-fail ยิงเตือนหลอก) |
| `health/health.html` | ไฟล์ที่ได้รับมา — ตัด inline `<style>`/`<script>` กับ Google Fonts ออก เพราะ CSP ของ server.mjs (`script-src 'self'; style-src 'self'`) บล็อกทั้งสามอย่าง |
| `public/health.css` · `public/health.js` | แยกออกจาก health.html ตามแบบหน้า stats/logs · ฟอนต์ใช้ `/fonts/plex.css` ที่มีอยู่แล้ว |
| `sql/202609172025_health.sql` | `001_health.sql` ที่ได้รับมา ตามเนื้อหาเดิมทุกบรรทัด — ย้ายมาไว้ที่ sql/ ตามกฎของ repo (ORDER.txt คือแหล่งความจริงเดียว ไม่เก็บสำเนาซ้ำใน health/) |
| `sql/ORDER.txt` | ลงทะเบียนไฟล์ใหม่ท้ายสุด |
| `server.mjs` | จุดต่อทั้งหมด (รายละเอียดด้านล่าง) |
| `Dockerfile` | `COPY health ./health` — ไม่งั้น import หาไม่เจอ container ขึ้นไม่ได้ |
| `.env.example` | ตัวแปรใหม่ของระบบเช็ค |
| `tests/http.integration.mjs` | ตั้ง `CONNECT_HEALTH: 'off'` ตอน spawn เซิร์ฟเวอร์ทดสอบ |

## จุดต่อใน server.mjs

- `createHealth({ getChannels })` — แปลง channels.json (`channel`/`access_token` แบบ snake_case) เป็น
  `{ key, type, accessToken }` ให้ตัวเช็คถาม token ทุกช่องทางที่เปิดใช้
- `health.handle(req, res)` เป็นด่านแรกของ `route()` — รับ /healthz, /admin/health, /api/health/*
- `health.log` ที่ 6 จุดตามแบบที่กำหนด:
  1. `webhook` — หลัง `webhook_accepted` (ref = log_id)
  2. `signature_fail` — หลังบันทึก `webhook_reject`
  3. `rpc` — ใน `callSupabase`: ล้มทุกครั้ง (ทั้งกรณีต่อไม่ถึงซึ่งเพิ่งเริ่มจับได้ และ HTTP ผิดปกติ)
     ส่วนสำเร็จเป็น heartbeat นาทีละครั้ง ไม่งั้น event พุ่งวันละหมื่นแถว
  4. `reply_queued` — หลัง `bot_reply` (ref = message_id) — **ข้ามในโหมดเงา** เพราะคิวขาออกไม่เดินโดยตั้งใจ
  5. `reply_sent` — หลัง `deliver` ของคิว `connect_private.delivery` ซึ่งเป็นทางส่งหาลูกค้าทางเดียวทั้งระบบ
     (ref = message_id จับคู่กับข้อ 4 ได้พอดี เพราะ delivery ใช้ message_id เป็น primary key)
  6. `telegram` — ทั้งของตัวเช็คเอง (ใน health.mjs) และทาง telegram ของการแจ้งทีม (runOutbound)
- `health.start()` ทำงานหลังบูต ปิดได้ด้วย `CONNECT_HEALTH=off` · `health.stop()` ใน SIGTERM

## ต่างจาก README ของชุดที่ส่งมา

1. SQL ไม่ได้อยู่ที่ `health/001_health.sql` — ย้ายเป็น `sql/202609172025_health.sql` ตามกฎของ repo
2. `core.profile(user_id, role)` ตรงกับที่ SQL สมมติ จึงไม่ต้องแก้ `inbox.health_role()`
3. channels.json จริงใช้ key ชื่อ `channel` กับ `access_token` — getChannels ใน server.mjs จัดการให้แล้ว
4. ชุดเดิมถาม token Messenger ผิด endpoint — แก้แล้ว (ดูตารางด้านบน)

## เหลือทำบน VPS (ผู้ดูแลระบบ)

1. รัน migration: `node sql/run.mjs apply --db ...` (ไฟล์รันซ้ำได้)
2. เติม `.env`: `HEALTH_TELEGRAM_TOKEN`, `HEALTH_TELEGRAM_CHAT_ID` (กลุ่มแยกจากทีมขาย) แล้ว
   `docker compose build && docker compose up -d`
3. เปิด `/admin/health` ด้วยบัญชี admin กด "ตรวจทุกขั้นตอนนี้"
4. ตั้ง UptimeRobot ยิง `/healthz` ทุก 5 นาที — จำเป็น เพราะ VPS ล่มทั้งเครื่องแล้วตัวเช็คข้างในเงียบด้วย
5. ถ้ากฎ gateway-fail ยิงหลอก (VPS ไม่รองรับ hairpin) ปิดกฎนั้นจากหน้าเว็บได้

## สิ่งที่ยังไม่ได้ทดสอบ

- หน้า HTML ในเบราว์เซอร์กับข้อมูลจริง และการยิง Telegram จริง (ต้องมี token จากขั้น 2)
- กฎบนข้อมูลเส้นทางจริง — ชุดทดสอบของผู้เขียนชุดเดิมพิสูจน์ฝั่ง SQL กับ Node แยกกันไว้แล้ว
