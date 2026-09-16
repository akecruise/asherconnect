# asher-connect — ระบบรับแชทลูกค้า ตอบด้วยบอท และแจ้งทีม

รับแชทจาก Messenger และ LINE → ฐานตัดสินใจ → บอทตอบ/แจ้งทีม → ทีมตอบต่อจากหน้าจอ

ระบบนี้คือของที่ย้ายลงมาจาก Supabase Edge Function บน cloud (`reference/bot-webhook.ts`)
มารันเองบน Docker + Supabase self-host

> **สถานะตอนนี้:** อยู่ใน**โหมดเงา** — รับเข้าและคิดคำตอบไว้ แต่ไม่ส่งอะไรออกไป
> cloud ยังเป็นตัวที่ตอบลูกค้าจริงอยู่ · แผนสลับดู **`docs/switchover.md`**
>
> **การแจ้งเตือนทีมยังไม่ทำงาน** — สาเหตุและวิธีแก้ทีละขั้นอยู่ที่ **`ROADMAP.md`**

---

## ใช้งาน

```powershell
docker compose up -d                        # ต้อง up -d เสมอ — restart ไม่โหลด .env ใหม่
curl.exe -s http://127.0.0.1:3200/health    # ดูสถานะ
```

เปิดหน้าจอทีมที่ http://localhost:3200

```bash
npm test          # เทสต์ทั้งชุด (auth · profile · providers · bots · report · outcomes · decide · http)
npm run check     # ตรวจ syntax + ตรวจ SQL ledger
npm run sql:plan  # ดูว่า SQL ไฟล์ไหนยังไม่ได้ลง
npm run sql:apply # ลง SQL ที่ยังขาด
```

---

## หลักการที่ระบบนี้ยึด

| กติกา | หมายความว่า |
|---|---|
| **ฐานเป็นคนตัดสินใจ** | "ตอบไหม · แจ้งไหม · หน่วงกี่วิ" ตัดสินใน SQL ไม่ใช่ใน Node — โค้ด Node แค่ทำตาม |
| **ปลายทางมาจาก env** | ฐานสั่งว่า "แจ้งทาง LINE" ส่วนแจ้งเข้ากลุ่มไหนมาจาก `.env` ของเครื่องที่รันอยู่ |
| **webhook ไม่ทำงานหนัก** | รับของดิบ เก็บ ตอบ 200 จบ · งานจริงเกิดทีหลังในคิว ห่างจากนาฬิกาของ LINE/Meta |
| **ทำซ้ำได้เสมอ** | ด่านกันซ้ำอยู่ที่ฐาน (`connect_private.inbound_event`) ยิง webhook เดิมซ้ำไม่ทำให้ของเบิ้ล |
| **โหมดเงาอ่านจากฐาน** | ไม่ใช่จำไว้ตอนบูต เพราะ admin กดสลับจากหน้าจอได้ และอาจมีหลายคอนเทนเนอร์ |

---

## เส้นทางของข้อความหนึ่งข้อความ

```
LINE / Messenger
   │ webhook
   ▼
connect_private.webhook_log        ← ของดิบ เก็บก่อนแปล
   │ providers.mjs แปลงเป็นรูปแบบกลาง
   ▼
connect_private.inbound_event      ← ด่านกันซ้ำ
   │ inbox.receive() — ฐานตัดสินใจตรงนี้
   ▼
connect_private.job                ← คิวงาน
   │
   ├─ generate  → เรียก Claude คิดคำตอบ      (BOT_KINDS)
   ├─ classify  → ถอดหมวดคำถาม               (BOT_KINDS)
   ├─ notify    → แจ้งทีม LINE/Telegram/Email (SEND_KINDS ← โหมดเงาบล็อกอยู่)
   └─ typing    → สัญญาณกำลังพิมพ์            (SEND_KINDS ← โหมดเงาบล็อกอยู่)
```

โหมดเงาบล็อก `SEND_KINDS` ทั้งกลุ่ม (`server.mjs:391`) จึงบล็อกการแจ้งทีมไปด้วย
ทั้งที่การแจ้งทีมไม่ใช่การส่งถึงลูกค้า — **นี่คือเหตุผลหลักที่แจ้งเตือนไม่ทำงาน ดู `ROADMAP.md` STEP 3**

---

## การแจ้งทีม

ปลายทางมาจาก `.env` ทั้งหมด (`bots/notify.mjs` → `notifyTargets()`)

| ช่อง | ยิงเมื่อไหร่ | env ที่ต้องมี |
|---|---|---|
| กลุ่ม LINE | **ทุกครั้ง**ที่มีคนทัก | `LINE_NOTIFY_GROUP_ID` + `LINE_NOTIFY_TOKEN` |
| Telegram | เฉพาะตอนลูกค้าให้เบอร์/LINE ID | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| อีเมล | เฉพาะตอนลูกค้าให้เบอร์/LINE ID | `RESEND_API_KEY` + `LEAD_EMAIL_TO` |

Telegram กับอีเมลไว้สะกิดคนที่ไม่ได้เฝ้าจอ จึงไม่ยิงทุกข้อความ — ตั้งใจให้เป็นแบบนี้ ไม่ใช่บั๊ก

ไม่ตั้ง env = ไม่มีปลายทาง = งานถูกข้ามด้วยเหตุผล `no_notify_target` **ไม่มี error ไม่มีเสียงเตือน**

### ⚠️ ชื่อ env ที่เปลี่ยนตอนย้ายจาก cloud

| cloud (เดิม) | self-host (ใหม่) |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | `LINE_NOTIFY_TOKEN` |
| `PAGE_ACCESS_TOKEN` | อยู่ใน `channels.json` ต่อ inbox แทน |
| `INTERNAL_SECRET` | ไม่ใช้แล้ว — worker อยู่ในโพรเซสเดียวกัน |

ก๊อป `.env` เดิมมาวางตรง ๆ จะเงียบสนิทโดยไม่ฟ้องอะไร

---

## คำสั่งในกลุ่ม LINE

พิมพ์ในกลุ่มที่เชิญบอทเข้าไปแล้ว (`sql/005_line.sql`)

| คำสั่ง | ได้อะไร |
|---|---|
| `ไอดีกลุ่ม` | group id ไว้ใส่ `LINE_NOTIFY_GROUP_ID` |
| `สถานะ` | บอทเปิดไหม ตารางเวลาเป็นยังไง มีงานค้างไหม |

> คำสั่งเหล่านี้ทำงานจริงแล้ว แต่**คำตอบยังส่งกลับไม่ได้ในโหมดเงา** เพราะคำตอบถูกเข้าคิวเป็นงาน `send`
> ระหว่างนี้อ่าน group id จากฐานแทน — ดู `ROADMAP.md` STEP 1

---

## บัญชีทดสอบ / คำสั่ง `test`

แชทที่ถูกตั้ง `mode='human'` บอทจะเงียบถาวร ไม่มีกลไกสลับกลับเอง
ทีมที่ต้องทดสอบบอทบ่อยจึงพิมพ์ `test` แล้วแชทนั้นกลับไปเริ่มใหม่ได้ทันที

### ตั้งค่า

```bash
# .env — คั่นด้วยจุลภาค · ใส่ได้ทั้ง LINE userId และ Messenger PSID
TEST_USER_IDS=U0090435e720c5a81158ba206830cceef,1234567890
```

ไม่ตั้ง = ฟีเจอร์ปิดสนิท ไม่มีใครสั่งได้

**รายชื่ออยู่ใน env ไม่ได้อยู่ในฐาน** — ฐานไม่ต้องรู้ว่าใครเป็นบัญชีทดสอบ รู้แค่ว่าถูกสั่งให้รีเซ็ตแชทไหน

### ใช้งาน

พิมพ์ **`test`** หรือ **`#test`** เข้าแชท (ไม่สนตัวพิมพ์เล็กใหญ่ ตัดช่องว่างหัวท้ายให้)

⚠️ **ต้องตรงทั้งข้อความเท่านั้น** — `test ระบบ` · `testing` · `test123` ถือเป็นข้อความลูกค้าปกติ
ถ้าจับแบบ "ขึ้นต้นด้วย test" ลูกค้าจริงที่พิมพ์คำนี้จะโดนรีเซ็ตแชทตัวเองโดยไม่รู้ตัว

บอทตอบกลับ `🧪 รีเซ็ตแล้ว — บอทพร้อมตอบ เริ่มทดสอบได้เลย`

### รีเซ็ตอะไร เก็บอะไร

| ล้าง | เก็บไว้ |
|---|---|
| `mode` → `bot` (`bot_active` ตามให้เองด้วย trigger) | ข้อความเดิมทุกข้อความ |
| `offtopic_count` · `offtopic_date` | `case_state.lead_id` |
| `last_human_reply_at` · `last_bot_reply_at` · `last_notified_at` | `case_state.first_human_response_at` |
| `sla_due_at` · `unread_count` | |
| `case_state`: `follow_up_at` · `appointment_at` · `waiting_since` (พร้อม `version` +1) | |
| งานใน `connect_private.job` ที่ยัง `pending` → `skipped` (`skip_reason='test_reset'`) | |

ทุกครั้งลง `connect_private.audit` action `test_reset` พร้อม `detail`:
`channel` · `user_id` · `previous_mode` · `cancelled_jobs` · `created`

เรียกซ้ำได้ (idempotent) · ยังไม่มีแถว conversation จะสร้างให้ (upsert) แล้วติดธงทันที

### ⚠️ `is_test` ติดถาวร

แชทที่ถูกรีเซ็ตจะได้ `inbox.conversation.is_test = true` **ตลอดไป ไม่มีคำสั่งปลด**

แปลว่าแชทนั้นจะ**ไม่ถูกนับในสถิติอีกเลย** — `reply_episodes` · `reply_report` · คะแนนผู้ตอบ · SLA · รายงาน Telegram

**ห้ามใส่ ID ที่ไม่แน่ใจว่าเป็นบัญชีทดสอบ** ถ้าใส่ ID ของลูกค้าจริงแล้วเขาบังเอิญพิมพ์ `test` แชทนั้นจะหลุดจากสถิติถาวรและกู้ไม่ได้ด้วยคำสั่ง

(แชทยังโผล่บนหน้าจอตามปกติ — `inbox.case_status` เปิดคอลัมน์ `is_test` ไว้ให้ UI ติดแท็ก)

### แจ้งเตือน

ข้อความปกติจากแชท `is_test` ยังเข้า pipeline ครบทุกขั้น แต่**ข้อความแจ้งทีมจะมี `[TEST]` นำหน้า**

```
[TEST] 🟡 มีคนทัก LINE (14:22 น.)
```

### เทสต์

```bash
node --test tests/testcmd.test.mjs                         # ตรรกะล้วน ไม่แตะฐาน
ALLOW_DB_TESTS=1 node --test tests/testreset.db.test.mjs    # ⚠️ เขียนลงฐานจริง
```

ชุดที่สอง **ข้ามทั้งไฟล์ถ้าไม่ตั้ง `ALLOW_DB_TESTS=1`** เพราะบนเครื่องที่ต่อกับ production มันจะเขียนลง production
มันกวาดแถว `__selftest__%` ทั้งก่อนและหลังรัน ตามลำดับ FK

---

## ไฟล์สำคัญ

| ไฟล์ | หน้าที่ |
|---|---|
| `server.mjs` | เซิร์ฟเวอร์ + worker คิว + เส้นทาง HTTP ทั้งหมด |
| `providers.mjs` | แปลง webhook ของแต่ละเจ้าเป็นรูปแบบกลาง และส่งของออก |
| `bots/notify.mjs` | เรียงคำข้อความแจ้งทีม + เลือกปลายทางจาก env |
| `bots/reply.mjs` · `bots/classify.mjs` | เรียก Claude คิดคำตอบ / ถอดหมวดคำถาม |
| `lib/claude.mjs` · `lib/profile.mjs` | ตัวเรียก API และการดึงชื่อ/รูปลูกค้า |
| `auth.mjs` | ล็อกอินรายบุคคล + session |
| `channels.json` | inbox ของแต่ละช่องทาง (token ต่อเพจ/OA) — **ไม่เข้า git** |
| `sql/` | สคีมาและฟังก์ชันของฐาน · ลงตามลำดับด้วย `npm run sql:apply` |
| `public/` | หน้าจอทีม |
| `reference/bot-webhook.ts` | โค้ดเดิมบน cloud ไว้เทียบพฤติกรรม |

---

## เอกสารอื่น

| ไฟล์ | เรื่อง |
|---|---|
| **`CONFIG.md`** | **ค่าที่ต้องเติมใน `.env` — อยู่ที่ไหน เอามาจากไหน หน้าตาเป็นยังไง** |
| **`ROADMAP.md`** | **แก้ปัญหาแจ้งเตือนไม่ทำงาน ทีละขั้น พร้อมตารางวินิจฉัยอาการ** |
| `docs/switchover.md` | แผนสลับจาก cloud มาที่นี่ · เกณฑ์ผ่าน · วิธีถอย |
| `docs/testing.md` | วิธีทดสอบ |
| `docs/individual-login.md` | ระบบล็อกอิน |
| `docs/stats-plan.md` | แผนหน้าสถิติ |
| `EDGE-FUNCTIONS.md` | ทะเบียน Edge Function ที่หน้าจอเรียกได้ |
| `INBOUND.md` | รายละเอียดขาเข้า |
| `PLAN-mobile.md` | แผนฝั่งมือถือ |

---

## ตรวจสุขภาพเร็ว ๆ

```sql
-- งานค้างในคิว แยกตามชนิดและสถานะ
select kind, status, count(*), max(created_at)
  from connect_private.job group by 1,2 order by 1,2;

-- งานแจ้งที่ถูกข้าม และเหตุผล
select id, channel, status, skip_reason, last_error, created_at
  from connect_private.job
 where kind = 'notify' order by id desc limit 20;

-- ของดิบเข้ามาครบไหม
select channel_key, status, count(*), max(received_at)
  from connect_private.webhook_log
 where received_at > now() - interval '1 day' group by 1,2;

-- ตัวตั้งเวลา
select jobname, schedule, active from cron.job;
```

`/health` บอก: `shadow` · `activeChannels` · `workerLastSuccess` · `memory.rssMb` · สวิตช์บอท
