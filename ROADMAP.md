# ROADMAP.md — แก้ปัญหา "แจ้งเตือนทีมที่เคยทำได้บน Supabase Cloud ตอนนี้ไม่ทำงาน"

ประเมินเมื่อ 16 กันยายน 2026 · ทุกข้อตรวจจากโค้ดและ `.env` จริง ไม่ใช่การคาดเดา

ใช้คู่กับ `README.md` (ภาพรวมระบบ) และ `docs/switchover.md` (แผนสลับจาก cloud)

---

## 0. สรุปสาเหตุ

**โค้ดไม่ได้พัง** — `npm test` ผ่าน 22/22 รวมถึงเทสต์ที่ยืนยันเส้นทางแจ้งเตือนโดยตรง
การแจ้งเตือนถูกปิดไว้ **3 ชั้นพร้อมกัน** ซึ่งทุกชั้นเป็นผลข้างเคียงของการย้ายจาก cloud มา self-host

| # | ชั้นที่ปิดอยู่ | หลักฐาน | ปิดที่ไหน |
|---|---|---|---|
| 1 | **โหมดเงาบล็อกงานแจ้งทั้งหมด** | `SEND_KINDS = ['notify','typing']` (`server.mjs:327`) · `const kinds = shadow ? BOT_KINDS : [...BOT_KINDS, ...SEND_KINDS]` (`server.mjs:391`) → งาน `notify` **ไม่ถูกหยิบจากคิวเลย** | `CONNECT_SHADOW_MODE=true` ใน `.env` |
| 2 | **ปลายทางว่างทุกช่อง** | `LINE_NOTIFY_GROUP_ID=` · `LINE_NOTIFY_TOKEN=` · `TELEGRAM_BOT_TOKEN=` · `TELEGRAM_CHAT_ID=` · `RESEND_API_KEY=` · `LEAD_EMAIL_TO=` — ว่างหมด → `notifyTargets()` คืน `[]` → `server.mjs:497-501` ข้ามงานด้วยเหตุผล `no_notify_target` | `.env` |
| 3 | **ชื่อ env เปลี่ยนตอนย้าย** | cloud ใช้ `LINE_CHANNEL_ACCESS_TOKEN` · ของใหม่ใช้ `LINE_NOTIFY_TOKEN` (`bots/notify.mjs:60`) — ก๊อป env เดิมมาวางจะเงียบสนิทโดยไม่มี error | `bots/notify.mjs` |

`.env` เขียนเตือนตัวเองไว้แล้วว่า *"ตอนนี้งานแจ้งถูกข้ามด้วยเหตุผล no_notify_target เพราะยังไม่มีปลายทางสักทาง"*

**ข้อสังเกตสำคัญ:** ชั้นที่ 1 บล็อกก่อนชั้นที่ 2 เสมอ — ต่อให้เติม env ครบ ถ้ายังอยู่โหมดเงา งานแจ้งก็ยังไม่ถูกหยิบ **ต้องแก้ทั้งสองชั้น ไม่ใช่ชั้นใดชั้นหนึ่ง**

---

## 1. ปัญหาเชิงออกแบบที่อยู่เบื้องหลัง

โหมดเงามีไว้เพื่อ **"ไม่ส่งอะไรถึงลูกค้า"** ระหว่างเทียบผลกับ cloud (ดู `docs/switchover.md`)

แต่โค้ดจัดกลุ่ม `notify` (แจ้ง**ทีม**) ไว้รวมกับ `typing` (ส่งถึง**ลูกค้า**) ใน `SEND_KINDS` เดียวกัน

ผลคือโหมดเงาปิดสิ่งที่ควรเปิด — ระหว่างช่วงเทียบผล ทีมควรได้เห็นว่าระบบใหม่ "จะแจ้งอะไรบ้าง" นั่นคือข้อมูลที่ต้องใช้เทียบ แต่กลับไม่เห็นอะไรเลย

เรื่องเดียวกันทำให้คำสั่ง `ไอดีกลุ่ม` ในกลุ่ม LINE ตอบไม่ได้ด้วย — คำสั่งนี้มีจริงและต่อสายแล้ว (`sql/005_line.sql:158-160`, `sql/006_receive_line.sql:53-67`) แต่คำตอบถูกเข้าคิวเป็นงาน `send` ซึ่งโหมดเงาก็บล็อกเช่นกัน (`server.mjs:396`)

> หมายเหตุ: `docs/switchover.md §7` เขียนว่าคำสั่งในกลุ่ม LINE "ยังไม่เข้า receive (รอ Phase 6)" — **เอกสารตรงนี้ล้าสมัยแล้ว** `sql/006_receive_line.sql` ต่อสายให้เรียบร้อยแล้ว

---

## 2. บันไดการแก้ 7 ขั้น

### STEP 0 — เปิดระบบให้ตรวจสอบได้

**ตอนนี้ยังทำไม่ได้** — Docker Desktop ไม่ได้รัน (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`)

```powershell
# เปิด Docker Desktop ก่อน แล้ว
docker compose up -d
curl.exe -s http://127.0.0.1:3200/health
```

**Checkpoint** — `/health` ตอบกลับและอ่านค่าสามตัวนี้ได้: `shadow` · `activeChannels` · `workerLastSuccess`

---

### STEP 1 — หา LINE_NOTIFY_GROUP_ID

ต้องมีค่านี้ก่อน ไม่งั้นทุกอย่างข้างหลังทดสอบไม่ได้

**ทางที่ใช้ได้ตอนนี้ (อ่านจากฐาน — ไม่ต้องปิดโหมดเงา)**

1. เชิญ LINE OA ตัวที่ `enabled: true` ใน `channels.json` เข้ากลุ่มที่ทีมเฝ้าอยู่
2. พิมพ์อะไรก็ได้ในกลุ่มหนึ่งข้อความ
3. อ่าน group id จากของดิบที่เก็บไว้:

```sql
select received_at, payload
  from connect_private.webhook_log
 where channel_key like '%line%'
   and payload::text like '%"groupId"%'
 order by received_at desc limit 5;
```

`providers.mjs:110` เก็บ `groupId` ไว้ให้แล้วตั้งแต่ตอนรับ webhook

**ทางที่ยังใช้ไม่ได้** — พิมพ์ `ไอดีกลุ่ม` ในกลุ่ม คำสั่งทำงานจริงแต่คำตอบถูกเข้าคิวเป็นงาน `send` ซึ่งโหมดเงาบล็อกอยู่ **จะใช้ทางนี้ได้หลัง STEP 3**

**Checkpoint** — ได้ค่าขึ้นต้นด้วย `C` ยาวประมาณ 33 ตัวอักษร

---

### STEP 2 — เติม env ที่หายไป

```bash
# .env
LINE_NOTIFY_GROUP_ID=<ค่าที่ได้จาก STEP 1>
LINE_NOTIFY_TOKEN=<access_token ของ LINE inbox ตัวที่ enabled=true ใน channels.json>
```

⚠️ **กับดักของการย้ายระบบ** — ถ้าคุณกำลังก๊อปจาก env เดิมของ cloud ชื่อตัวแปรเปลี่ยนแล้ว:

| cloud (เดิม) | self-host (ใหม่) |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | `LINE_NOTIFY_TOKEN` |
| `LINE_NOTIFY_GROUP_ID` | `LINE_NOTIFY_GROUP_ID` (เหมือนเดิม) |

LINE OA ตัวเดียวกันใช้ได้ทั้งรับแชทลูกค้าและ push เข้ากลุ่ม — ไม่ต้องสร้าง OA ใหม่

```powershell
docker compose up -d      # ต้อง up -d — restart เฉย ๆ ไม่โหลด env ใหม่
docker exec asher-connect node -e "console.log(!!process.env.LINE_NOTIFY_TOKEN, !!process.env.LINE_NOTIFY_GROUP_ID)"
```

**Checkpoint** — ได้ `true true`

---

### STEP 3 — แยกงานแจ้งทีมออกจากโหมดเงา ← หัวใจของการแก้ · ✅ แก้แล้ว 16 ก.ย. 2026

นี่คือขั้นที่ทำให้การแจ้งเตือนกลับมาทำงานโดย**ไม่ต้อง**เสี่ยงส่งข้อความถึงลูกค้า

แก้ที่ `server.mjs:326-332` และ `396-397` แล้ว:

```js
const BOT_KINDS  = ['generate', 'classify']
const TEAM_KINDS = ['notify']     // แจ้งทีม — ไม่ใช่ข้อความถึงลูกค้า โหมดเงาไม่ควรบล็อก
const SEND_KINDS = ['typing']     // ถึงลูกค้าจริง — โหมดเงาต้องบล็อก

// ในฟังก์ชัน nextJob()
const kinds = shadow ? [...BOT_KINDS, ...TEAM_KINDS] : [...BOT_KINDS, ...TEAM_KINDS, ...SEND_KINDS]
```

ด่านที่กันข้อความถึงลูกค้า **คงไว้ครบทั้งสองจุด**
- `server.mjs:402` `if (shadow) return null` — ไม่แตะคิว delivery ของลูกค้า
- `server.mjs:873` `if (shadow) throw fail(503, 'shadow_mode')` — ปุ่มส่งบนหน้าจอยังกดไม่ได้ในโหมดเงา

ยืนยัน: `node --check server.mjs` ผ่าน · เทสต์ตรรกะล้วน 79/79 ผ่าน (providers 40 · bots 22 · profile 15 · auth 2)

⚠️ **ระหว่างช่วงเทียบผลสามวัน cloud ยังแจ้งอยู่ด้วย** → ทีมจะได้ข้อความซ้ำสองชุด เลือกทางใดทางหนึ่งก่อนเปิด:
- ใส่คำนำหน้าให้ของฝั่ง local เช่น `[ระบบใหม่]` เพื่อให้ทีมแยกออก (แก้ที่ `bots/notify.mjs` → `headline()`)
- หรือปิดการแจ้งฝั่ง cloud ก่อน แล้วให้ local รับงานแจ้งไปเลย (แต่ยังไม่ตอบลูกค้า)

**Checkpoint** — ทักเข้าเพจ/LINE หนึ่งข้อความในช่วงเวลาที่ต้องแจ้ง แล้วต้องได้ทั้งสองอย่างพร้อมกัน:
1. กลุ่ม LINE เด้งข้อความแจ้ง
2. ลูกค้า **ไม่ได้รับ**อะไรเลย

---

### STEP 4 — ทดสอบให้ครบเส้นทาง

```sql
-- งานแจ้งเดินถึงไหนแล้ว
select id, kind, channel, status, skip_reason, last_error, created_at
  from connect_private.job
 where kind = 'notify'
 order by id desc limit 20;
```

**Checkpoint** — แถวล่าสุดต้องเป็น `status='done'` ไม่ใช่ `skipped` และ `skip_reason` ต้องว่าง

---

### STEP 5 — Telegram และอีเมล (เฉพาะตอนได้ lead)

สองช่องนี้ยิงเฉพาะตอนลูกค้าให้เบอร์หรือ LINE ID มา (`bots/notify.mjs:64-71`) — ตั้งใจให้เป็นแบบนี้ ไม่ใช่บั๊ก

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
RESEND_API_KEY=
LEAD_EMAIL_TO=
LEAD_EMAIL_FROM=onboarding@resend.dev
```

**Checkpoint** — ส่งข้อความที่มีเบอร์โทรไทย (เช่น `0812345678`) แล้วต้องเด้งครบสามทาง: LINE + Telegram + อีเมล

---

### STEP 6 — watchdog และรายงาน 09:00

ทั้งสองตัวตั้ง `pg_cron` ไว้แล้วตาม `docs/switchover.md §0` แต่ปลายทางว่างจึงถูกข้าม

```sql
select jobname, schedule, active from cron.job;
```

ต้องเห็น `asher-watchdog` (ทุกนาที) และ `asher-daily-report` (02:00 UTC = 09:00 ไทย)

**Checkpoint** — ปล่อยแชทค้างไว้เกิน 2 ชั่วโมงในช่วง 09:00–19:00 แล้วต้องได้ข้อความ `🟠 ค้างตอบ` เข้ากลุ่ม LINE

---

### STEP 7 — วันสลับจริง

ทำตาม `docs/switchover.md §5` ตามลำดับ ห้ามสลับลำดับ

**Checkpoint** — `/health` แสดง `shadow: false` และ `workerLastSuccess` ขยับทุกรอบ

---

## 3. ตารางวินิจฉัยอาการ

| อาการที่เห็น | ดูที่ไหน | แปลว่า | แก้ที่ |
|---|---|---|---|
| งาน `notify` ค้าง `pending` ไม่เคยถูกหยิบ | `connect_private.job` | โหมดเงาบล็อกอยู่ | STEP 3 |
| `skip_reason='no_notify_target'` | `connect_private.job` | env ปลายทางว่างทุกช่อง | STEP 2 |
| `last_error='line_token_missing'` | `connect_private.job` | `LINE_NOTIFY_TOKEN` ว่าง (`providers.mjs:363`) | STEP 2 |
| `skip_reason='no_target'` หรือ `recipient_not_configured` | `connect_private.job` | `LINE_NOTIFY_GROUP_ID` ว่าง (`providers.mjs:335`) | STEP 1 |
| `provider_http_401` / `403` | `last_error` | token ผิดหรือหมดอายุ | ออก access token ใหม่จาก LINE Developers |
| `provider_http_400` | `last_error` | group id ผิด หรือบอทถูกเตะออกจากกลุ่ม | STEP 1 ใหม่ |
| ทีมได้ข้อความซ้ำสองชุด | กลุ่ม LINE | cloud กับ local แจ้งพร้อมกัน | ปิดฝั่งใดฝั่งหนึ่ง (STEP 3) |
| `/health` เรียกไม่ได้ | — | Docker ไม่ได้รัน | STEP 0 |

---

## 4. ตารางสรุป

| Step | ทำอะไร | สถานะ | ต้องแก้โค้ดไหม | ขึ้นกับ |
|---|---|---|---|---|
| 0 | เปิด Docker + `/health` | ⬜ รอคุณเปิด Docker | ไม่ | — |
| 1 | หา LINE group id | ⬜ รอ Docker | ไม่ | 0 |
| 2 | เติม env (ระวังชื่อเปลี่ยน) | 🔶 `LINE_NOTIFY_TOKEN` เติมแล้ว · เหลือ `LINE_NOTIFY_GROUP_ID` + `ANTHROPIC_API_KEY` | ไม่ | 1 |
| 3 | **แยก notify ออกจาก SEND_KINDS** | ✅ **เสร็จแล้ว** | ใช่ — `server.mjs` | 2 |
| 4 | ทดสอบเส้นทางครบ | ยังไม่ได้ | ไม่ | 3 |
| 5 | Telegram + อีเมล | ยังไม่ได้ | ไม่ | 4 |
| 6 | watchdog + รายงาน 09:00 | cron ตั้งแล้ว รอปลายทาง | ไม่ | 4 |
| 7 | สลับจาก cloud จริง | ยังไม่ได้ | ไม่ | 5, 6 |

**ทางวิกฤต:** `0 → 1 → 2 → 3 → 4`

STEP 0–2 ไม่ต้องแตะโค้ดเลย แก้ `.env` อย่างเดียว · มีแค่ STEP 3 ที่ต้องแก้โค้ด และแก้แค่สามบรรทัด

---

## 5. หมายเหตุ

โค้ดส่วนแจ้งเตือนเขียนไว้ถูกต้องครบแล้ว — ชื่อ config ตรงกันทุกจุด (`notify.mjs` ส่ง `access_token` · `providers.mjs:363` อ่าน `access_token`) และมีเทสต์คุมอยู่

`tests/bots.test.mjs:239` ยืนยันพฤติกรรมนี้ไว้ตรง ๆ:

```js
assert.deepEqual(notifyTargets({ phone: '0812345678' }, {}), [])   // ไม่ตั้ง env = ไม่มีปลายทาง
```

แปลว่าระบบกำลังทำงาน**ถูกต้องตามที่ถูกสั่ง** — มันถูกสั่งให้เงียบ เพราะยังไม่มีใครบอกว่าให้แจ้งไปที่ไหน
