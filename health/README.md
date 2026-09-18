# asher-connect: หน้าสถานะระบบ + ระบบเช็ค

ติดตั้งแล้วใน repo นี้ตั้งแต่ 2026-09-17 ประกอบด้วย:

| ไฟล์ | หน้าที่ |
|---|---|
| `sql/202609172025_health.sql` | ตาราง event, ตารางกฎ, ฟังก์ชันประเมินกฎ, snapshot, สิทธิ์ (รันซ้ำได้) |
| `health/health.mjs` | บันทึก event, ตรวจ gateway / TLS / token ทุกนาที-ชั่วโมง, ยิง Telegram, route ของหน้า admin |
| `health/health.html` | หน้า `/admin/health` (manager ดูได้, admin แก้กฎได้) |
| `public/health.css` · `public/health.js` | แผ่นสไตล์กับสคริปต์ของหน้า — แยกไฟล์เพราะ CSP อนุญาตแค่ self |

## ระบบเช็คทำงานยังไง

- `server.mjs` เรียก `health.log(...)` ที่ 6 จุด: รับ webhook, signature ไม่ผ่าน, เรียก RPC, เข้าคิวตอบ,
  ส่งตอบ, ส่ง Telegram — ทุกอย่างลงตารางเดียวคือ `inbox.flow_event`
- ทุก 1 นาที ตัวเช็คยิงออกไปที่โดเมนจริงแล้ววนกลับเข้า Caddy (ได้ DNS + TLS + proxy ในครั้งเดียว)
  ทุก 1 ชั่วโมงเช็ควันหมดอายุ TLS และถาม LINE/Meta ว่า access token ยังใช้ได้ไหม โดยไม่ส่งอะไรถึงลูกค้า
- กฎ 11 ข้ออยู่ในตาราง `inbox.monitor_rule` ประเมินใน SQL เมื่อสถานะเปลี่ยนจึงยิง Telegram ครั้งเดียว
  และยิงอีกครั้งตอนกลับมาปกติ
- กฎ "ไม่มีข้อความเข้า" นับเฉพาะในช่วงเวลาที่ตั้งไว้ (06:00–24:00) กลางคืนเงียบจึงไม่กลายเป็นเตือนตอน 06:00 ตรง
- การจับคู่ "คิวค้าง" ใช้ `message_id` เป็น `ref` — `bot_reply` คืน id นี้ และคิว `connect_private.delivery`
  ใช้ id นี้เป็น primary key อยู่แล้ว
- ในโหมดเงาไม่บันทึก `reply_queued` เพราะคิวขาออกไม่เดินโดยตั้งใจ กฎคิวค้างจึงไม่ยิงหลอก
- `/healthz` สำหรับ uptime monitor ภายนอก — ตัวนี้จำเป็น เพราะถ้า VPS ล่มทั้งเครื่อง
  ระบบเช็คข้างในจะเงียบไปด้วย

## ขั้นตอนลง VPS

1. `node sql/run.mjs apply --db ...` (หรือรันไฟล์ `sql/202609172025_health.sql` ตรง ๆ — รันซ้ำได้)
2. เติมใน `.env` ของเครื่อง VPS แล้ว `docker compose up -d` (rebuild เพราะ Dockerfile เพิ่ม COPY health):

   ```
   HEALTH_TELEGRAM_TOKEN=...      # bot token ของกลุ่มแจ้งเตือน
   HEALTH_TELEGRAM_CHAT_ID=...    # กลุ่มที่ admin อยู่ แนะนำแยกจากกลุ่มทีมขาย
   ```
3. เปิด `https://inbox.apluscondo.com/admin/health` เข้าด้วยบัญชี admin กด "ตรวจทุกขั้นตอนนี้"
4. ตั้ง UptimeRobot (หรือตัวอื่น) ยิง `https://inbox.apluscondo.com/healthz` ทุก 5 นาที

## ข้อควรรู้

- การตรวจ gateway ยิงจาก container ออกไปที่โดเมนจริงแล้ววนกลับ ถ้า VPS ไม่รองรับ hairpin
  จะขึ้น "เข้าไม่ได้" ทั้งที่ข้างนอกเข้าได้ ให้ปิดกฎ `gateway-fail` แล้วพึ่ง UptimeRobot แทน
- Messenger ถูกถามด้วย `debug_token` ไม่ใช่ `/me` — token ที่มีแค่ `pages_messaging` จะตอบ error
  ถ้าถามผิดข้อ (เหตุผลเดียวกับ `checkToken` ใน server.mjs)
- กล่อง Sales Workspace ยังไม่มีตัวเลข เติมได้ที่ `inbox.health_workspace()` ให้คืน jsonb
  เช่น `{"เคสเปิดอยู่": 7, "เกิน SLA": 0}` หน้าเว็บแสดงทุก key ที่ได้
- ปิดตัวเช็คที่วิ่งเป็นรอบด้วย `CONNECT_HEALTH=off` (ชุดทดสอบตั้งให้แล้ว)

## แก้กฎ

แก้จากหน้าเว็บได้: เปิด/ปิด, ตัวเลขเกณฑ์, ระดับ, แจ้ง Telegram
ส่วนช่วงเวลา (`hour_from`, `hour_to`), หน้าต่างเวลาของ `fail_count` (`params.minutes`) และการเพิ่มกฎใหม่ ทำด้วย SQL:

```sql
insert into inbox.monitor_rule (id, name, node, kind, params, level, notify, hour_from, hour_to)
values ('naii-line-silence', 'ไม่มีข้อความเข้า LINE ทดสอบ', 'in:naii-line',
        'silence', '{"stage":"webhook","channel":"naii-line","minutes":720}', 'warn', false, 6, 24);
```

`node` คือกล่องที่กฎนี้ระบายสี: `in:<channel key>`, `gateway`, `app`, `db`, `out:bot`, `out:workspace`, `out:telegram`
event เก็บ 30 วัน แล้วลบเองตอน tick
