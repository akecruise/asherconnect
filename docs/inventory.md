# Phase 0 — สำรวจ: ของที่ `bot-webhook` ใช้ เทียบกับของที่ `inbox` มี

อัปเดต 2026-09-14 · ยังไม่แก้โค้ด ไม่มี migration ในเฟสนี้

---

## 0. ไฟล์ที่อ่านจริง และปัญหาแรกที่เจอ

**โฟลเดอร์ `reference/` ไม่มีอยู่จริง** ทั้งใน `D:\aplus_postgres_docker\` และใน `asher-connect\`
ของอ้างอิงอยู่ใน `C:\Users\ADMin\Downloads\` ปนกับไฟล์เวอร์ชันเก่าหลายตัว จึงเลือกตามวันที่และขนาด

| PLAN เรียกว่า | ไฟล์ที่ใช้จริง | ขนาด · วันที่ | ยืนยันว่าใช่เพราะ |
|---|---|---|---|
| `reference/bot-webhook.ts` | `Downloads\bot-webhook_fixed.ts` | 119,053 B · 09-09 21:37 | ไฟล์เดียวที่มี `SCENARIOS` 20 ข้อ + `WATCHDOG_SCENARIOS` 9 ข้อครบตาม PLAN และใหม่ที่สุด |
| `reference/line-webhook.ts` | `Downloads\line-webhook.ts` | 80,157 B · 09-08 20:30 | หัวไฟล์เขียน `ASHER LINE OA WEBHOOK v3.1-line` ตรงกับที่ PLAN ระบุ |
| `reference/fbline_report_TG.ts` | **ไม่พบ** | — | ไม่มีไฟล์ไหนใน Downloads ที่มี `loadReportData` / `buildDailyDigest` / `fmtMin` เลย |

ไฟล์ที่ตัดออก: `bot-webhook-index.ts` และ `(1) (2)` (09-06, เก่ากว่า), `index (1)–(5).ts`
(09-09 09:42–15:49 เนื้อหาเกือบเหมือน `bot-webhook_fixed.ts` แต่เก่ากว่า), `line-webhook-index.ts` (09-06),
`daily-report.ts` (08-26 · 6 KB · ไม่ใช่ตัวเดียวกับ `fbline_report_TG`), `index.ts` (08-26)

ของฝั่งเรา: `asher-connect/server.mjs` (419 บรรทัด), `providers.mjs`, `database.sql`,
`migrations/20260914-shadow-replay.sql`, และ schema จริงในฐาน (`inbox`, `connect_private`, `core`, `crm`, `bot`)

---

## 1. ภาพรวมความต่างของสองระบบ

| | cloud (`bot-webhook`, `line-webhook`) | local (`asher-connect` + schema `inbox`) |
|---|---|---|
| หน่วยของลูกค้า | `customers` แถวเดียวถือ `psid` **และ** `line_user_id` | `core.contact` + `core.contact_identity` หนึ่งแถวต่อหนึ่งช่องทาง |
| หน่วยของกล่อง | ไม่มี — ใช้คอลัมน์ `platform` บน conversation | `inbox.inbox` หนึ่งแถวต่อหนึ่งเพจ/OA ผูก `project_id` |
| บทสนทนา | `conversations` (มี state ของบอทอยู่ในตัว 8 คอลัมน์) | `inbox.conversation` (ไม่มี state ของบอทเลย) + `connect_private.case_state` (state ของ **งานขาย** ไม่ใช่ของบอท) |
| ข้อความ | `messages.role` = customer / bot / human | `inbox.message.sender_type` = contact / bot / agent / system |
| คิว | `reply_queue` (ให้บอทตอบทีหลัง) + `notify_queue` (digest) แยกกัน | `connect_private.delivery` คิวเดียว **ผูกกับ message ที่มีอยู่แล้ว** |
| ตรรกะตัดสินใจ | TypeScript ใน edge function | ยังไม่มีที่ไหนเลย |
| กันซ้ำ | unique บน `messages.mid` (จับ error 23505) | `connect_private.inbound_event (inbox_id, event_id)` |
| ของดิบ | ไม่เก็บ (มีแต่ `console.log`) | `connect_private.webhook_log` เก็บ 30 วัน |

**ข้อสรุปสำคัญ: ไม่มีตารางของ cloud ตัวไหนอยู่ในฐาน local เลยสักตัว**
ตรวจแล้วทั้ง `customers`, `conversations`, `messages`, `reply_queue`, `notify_queue`,
`bot_decisions`, `message_intents`, `reply_report_daily` — ไม่มีใน schema ไหนของฐานนี้
(`public.leads` มีอยู่ แต่เป็นตาราง legacy คนละตัว มี 0 แถว)

แปลว่า Phase 1 ไม่ใช่การ "เพิ่มคอลัมน์" แต่เป็นการ **ตัดสินใจว่าจะยกของ cloud มาวางที่ไหนใน inbox**

---

## 2. เทียบรายตาราง

### 2.1 `customers` → `core.contact` + `core.contact_identity`

| cloud | ใช้ทำอะไร | ที่ local | สถานะ |
|---|---|---|---|
| `psid` | คีย์ของ Messenger | `contact_identity(channel='messenger', external_id, account_key=inbox_id)` | ✅ มี (`core.resolve_identity()` upsert ให้) |
| `line_user_id` | คีย์ของ LINE | `contact_identity(channel='line', ...)` | ✅ มี |
| `name` | ชื่อจาก Profile API | `contact.display_name` | ✅ มี |
| `line_blocked` | ลูกค้าบล็อก OA (Phase 6) | — | ❌ **ขาด** |
| `test_clock`, `test_as_customer` | โหมดทดสอบของแอดมิน | — | ❌ ขาด (PLAN สั่งตัดทิ้ง/ย้ายไป `bot_config`) |

หนึ่งลูกค้าใน cloud = หนึ่งแถว ถือทั้งสองช่องทาง · ที่ local = หนึ่ง contact ผูกหลาย identity
**ดีกว่าของเดิม** แต่แปลว่าโค้ดที่ port มาต้องเลิกคิดแบบ `customers.psid`

### 2.2 `conversations` → `inbox.conversation`

| cloud | ที่ local | สถานะ |
|---|---|---|
| `id`, `customer_id` | `id`, `contact_id` | ✅ |
| `platform` | ได้จาก `inbox.inbox.channel` ผ่าน `inbox_id` | ✅ (ดีกว่า — แยกได้ถึงระดับเพจ ไม่ใช่แค่ platform) |
| `project_name` (text) | `inbox.project_id` → `core.project` | ✅ (ดีกว่า — เป็น FK ไม่ใช่ข้อความ) |
| `last_message_at` | `last_message_at` | ✅ |
| `mode` ('bot'/'human') | `bot_active` (boolean) | ⚠️ **ชนกัน** — ความหมายซ้อนกันแต่ชนิดต่างกัน ดูข้อ 4.1 |
| `last_human_reply_at` | — (`case_state.first_human_response_at` คือ **ครั้งแรก** ไม่ใช่ล่าสุด) | ❌ **ขาด** |
| `last_bot_reply_at` | — | ❌ ขาด |
| `last_notified_at` | — | ❌ ขาด |
| `ad_id`, `ad_title` | — | ❌ ขาด |
| `offtopic_count`, `offtopic_date` | — | ❌ ขาด |

`last_human_reply_at` เป็นหัวใจของ `decideReply` (humanOwnsConvoHours / humanHoldMin)
และของ Phase 7 (LINE fallback) — **ขาดตัวนี้ตัวเดียว ตรรกะบอททั้งชุดทำงานไม่ได้**

### 2.3 `messages` → `inbox.message`

| cloud | ที่ local | สถานะ |
|---|---|---|
| `role` customer/bot/human | `sender_type` contact/bot/agent | ✅ แมปได้ 1:1 (customer→contact, human→agent) |
| `content` | `content` | ✅ |
| `mid` | `external_message_id` + `connect_private.inbound_event` | ✅ |
| `created_at` | `created_at` | ✅ |
| `platform` | ได้จาก conversation → inbox | ✅ |
| `attachment_type` | `content_type` (บางส่วน) | ⚠️ `content_type` ตอนนี้เก็บชนิดของ LINE (`image`/`sticker`) ปนกับ `'text'` — ความหมายใกล้กันแต่ไม่ตรงกันเป๊ะ |
| `responder_type`, `responder_id`, `responder_name` | `sender_id` (uuid ของ user) | ❌ **ขาด** — ของ cloud เก็บ "ชื่อคนตอบที่เดาจากลายเซ็นท้ายข้อความ" ซึ่งเป็นข้อมูลคนละชนิดกับ uuid ของ user ที่ล็อกอิน |
| — | `event_type` (เพิ่งเพิ่ม 2026-09-14) | ✅ ล่วงหน้าไปแล้ว รองรับ message/postback/follow/unfollow/other |

`responder_name` ใช้ทำสถิติรายคนใน Phase 7 — ถ้าไม่มี จะรู้แค่ว่า "มีคนตอบ" ไม่รู้ว่าใคร
ใน Sales Workspace เรารู้จาก `sender_id` อยู่แล้ว แต่คนที่ตอบจาก Business Suite / chat.line.biz ไม่มี uuid

### 2.4 `leads` → `crm.lead`

| cloud | ที่ local | สถานะ |
|---|---|---|
| `customer_id` | `contact_id` | ✅ |
| `phone` | `core.contact.phone` (ไม่ใช่บน lead) | ⚠️ ย้ายที่ |
| `project_name` | `project_id` | ✅ |
| `message` | — | ❌ ขาด (มี `last_touch jsonb` พอใส่ได้) |
| `status` ('new') | `stage_id` → `crm.stage` | ✅ (ละเอียดกว่า) |

`connect_private.ensure_lead(conversation_id)` สร้าง lead ให้อัตโนมัติอยู่แล้ว ไม่ต้อง insert เอง

### 2.5 `reply_queue` → **ไม่มีของเทียบ**

| cloud | ที่ local |
|---|---|
| `conversation_id`, `psid`, `mid`, `msg_at` | — |
| `send_at` | `delivery.available_at` (ชื่อต่าง ความหมายเดียวกัน) |
| `sent_at` / `skipped_reason` | `delivery.status` + `last_error` (ดีกว่า — มีสถานะชัด ไม่ใช่ใช้ `sent_at` เป็นทั้ง lock และผลลัพธ์) |
| `reason`, `is_new_chat` | — |

**ข้อขัดที่ใหญ่ที่สุดของทั้งงานนี้:**
`connect_private.delivery` มี primary key เป็น `message_id` และ FK ไป `inbox.message`
แปลว่า **ทุกงานในคิวต้องมีข้อความอยู่ในฐานก่อน**

แต่ `reply_queue` ของ cloud คืองาน "อีก 30 นาทีค่อยไป *สร้าง* คำตอบ" — ตอนเข้าคิวยังไม่มีข้อความ
และ PLAN ข้อ 2 สั่งให้ `generate` / `classify` / `notify` อยู่ใน outbox ตัวเดียวกัน
ซึ่งทั้งสามอย่างนี้ไม่มี `message_id` ตอนเข้าคิว

→ เป็นคำถามข้อ 6.1

### 2.6 ตารางที่ไม่มีอะไรเทียบเลย

| cloud | คอลัมน์ที่ใช้จริง | ใครใช้ |
|---|---|---|
| `notify_queue` | `conversation_id`, `text`, `send_at` | โหมด `outsideHours: "queue"` (ตอนนี้ FB ตั้ง `skip` · LINE ตั้ง `send` จึงยังไม่ถูกใช้) |
| `bot_decisions` | `conversation_id`, `topic`, `reply_go`, `reply_reason`, `notify_go`, `notify_reason`, `delay_sec`, `text` | **เกณฑ์วัดตอน switchover** (PLAN: ตรงกับ cloud ≥ 99%) |
| `message_intents` | 18 คอลัมน์ (`psid_hash`, `platform`, `project`, `primary_topic`, `primary_l2`, `secondary_topics[]`, `stage`, `objection`, `budget_signal`, `urgency`, `confidence`, `classifier`, `raw_question`, `ad_id`, `ad_title`, `is_new_chat`, `bot_replied`) | เก็บ insight จาก Claude |
| `reply_report_daily` | `report_date`, `replies`, … | รายงาน 09:00 |
| RPC `match_knowledge(query_embedding, match_count, filter_project)` | RAG | `generateReply()` |
| RPC `reply_episodes(p_from, p_to)` | สถิติรอบการตอบ | digest + Phase 7 |

---

## 3. ของที่ local มีอยู่แล้ว และ PLAN ยังไม่รู้ว่ามี

งานบางข้อใน PLAN ทำไปแล้วเมื่อ 2026-09-14 (migration `20260914120000`)

| PLAN Phase 1 ขอ | สถานะจริง |
|---|---|
| `inbox.webhook_log(id, inbox_id, channel, received_at, raw, processed_at)` + retention 30 วัน | ✅ **มีแล้ว** ชื่อ `connect_private.webhook_log` · คอลัมน์ `payload` (ไม่ใช่ `raw`) · มี `status/attempts/lease_id` เพิ่มเพราะเป็นคิวในตัว · retention 30 วันผ่าน `worker('sweep')` |
| unique `(inbox_id, event_id)` | ✅ **มีแล้ว** `connect_private.inbound_event` |
| outbox `payload jsonb` แทน `text` | ✅ **มีแล้ว** `delivery.payload` + `renderPayload()` รองรับ text / quick_replies / image / raw |
| outbox `send_after` | ✅ มีแล้วชื่อ `available_at` |
| webhook ตอบ 200 ทันทีหลัง insert raw | ✅ **ทำแล้ว** (`handleWebhook` → `worker('log')` → 200 · งานจริงอยู่ใน `inboundWorker()`) |
| `event_type` ใน normalize | ✅ ทำแล้วทั้ง LINE และ Messenger |
| outbox `kind` | ❌ ยังไม่มี |
| outbox `target` | ⚠️ ตอนนี้หาปลายทางตอน claim (join `contact_identity`) ไม่ได้เก็บเป็นคอลัมน์ |

ของอื่นที่มีอยู่แล้วและเกี่ยวข้อง

- `bot.pending_draft(conversation_id, draft, model)` — **ทับซ้อนกับ job kind `generate`** ของ PLAN
- `bot.reply_sample(message_id, conversation_id, context jsonb, bot_draft, bot_model, think_seconds, agent_id)` — เก็บ "สถานการณ์ + คำตอบของคน + ร่างของบอท" ไว้สอนบอท **ทับซ้อนกับ `message_intents` บางส่วน**
- `bot.reply_outcome(message_id, customer_replied, stage_advanced, lead_won, …)` — ผลลัพธ์หลังตอบ ของ cloud ไม่มีส่วนนี้
- `ops.job_schedule(job, label, max_age_hours, is_active)` + `ops.job_run` — ทะเบียนงานตั้งเวลาของโปรเจกต์นี้ (ตอนนี้ขับด้วย Windows Task Scheduler)
- `connect_private.replay()` — ทางบันทึกคำตอบของบอทตัวเดิมโดยไม่ส่งออก (ใช้ตอนโหมดเงา)

---

## 4. ชื่อที่ชนกัน

### 4.1 `mode` ↔ `bot_active` — ชนกันที่ความหมาย
cloud: `conversations.mode` เป็น text ('bot' / 'human') และ `decideReply` อ่านตรง ๆ
local: `inbox.conversation.bot_active` เป็น boolean
PLAN Phase 1 สั่งให้เพิ่ม `mode` — ถ้าเพิ่มโดยไม่จัดการ `bot_active` จะมีสองที่ที่บอกเรื่องเดียวกัน
แล้ววันหนึ่งมันจะไม่ตรงกัน

### 4.2 `messages` — ชื่อเดียวกัน คนละตาราง
`realtime.messages` (ของ Supabase เอง) มีอยู่ในฐานนี้แล้ว
ไม่กระทบเพราะคนละ schema แต่เวลาเขียน SQL ที่ไม่ระบุ schema ต้องระวัง

### 4.3 `leads` — มีสองตัวจริง
`public.leads` (legacy, 0 แถว) กับ `crm.lead` (ของจริง)
โค้ดที่ port มาจาก cloud เขียนว่า `.from("leads")` → ถ้าแปลตรงตัวจะไปลง legacy ที่ไม่มีใครอ่าน

### 4.4 `webhook_log` — PLAN บอก `inbox.` ของจริงอยู่ `connect_private.`
ของจริงอยู่ `connect_private.webhook_log` เพราะเป็นของภายในที่เบราว์เซอร์ไม่ควรเห็น
(`connect_private` ถูก revoke จาก `authenticated` ทั้ง schema ส่วน `inbox` เปิดให้ผ่าน RLS)
**เสนอให้คงไว้ที่ `connect_private`** ไม่ย้ายตาม PLAN — แต่ต้องให้ผู้ใช้ตัดสิน

### 4.5 `responder_name` ↔ `sender_id` — ข้อมูลคนละชนิด
ของ cloud เดาชื่อคนตอบจาก regex ลายเซ็นท้ายข้อความ (`-มิ้นท์`, `(ก้อง)`)
ของ local เก็บ uuid ของ user ที่ล็อกอิน
ทั้งคู่ตอบคำถาม "ใครตอบ" แต่แหล่งที่มาต่างกันคนละโลก รวมเป็นคอลัมน์เดียวไม่ได้

---

## 5. ตรรกะและของนอกฐานที่ต้องมีที่อยู่

### 5.1 ตรรกะที่ต้อง port (Phase 3)

| ของเดิม | บรรทัด | รับอะไร | หมายเหตุ |
|---|---|---|---|
| `decideReply(Ctx)` | 177 | 13 ฟิลด์ | อ่าน `CONFIG.REPLY` + `currentWindow()` |
| `decideNotify(Ctx, Verdict)` | 192 | + ผลของ decideReply | |
| `decideDelay(Ctx, Verdict)` | 211 | | มี `Math.random()` — **ต้องแยก jitter ออกจากตรรกะ** ไม่งั้น test ไม่ deterministic |
| `decideAll` | 220 | | รวมสามตัว + คิด `notifyAction` (send/queue/skip/none) |
| `decideWatchdog(WdCtx)` | 240 | 6 ฟิลด์ | |
| `SCENARIOS` | 331 | 20 ข้อ | ผูกกับ CONFIG ของ FB โดยตรง |
| `WATCHDOG_SCENARIOS` | 280 | 9 ข้อ | |

ทั้งหมดอ่านเวลาปัจจุบันผ่าน `bangkokHour()` ซึ่งอ่าน global `CLOCK` → PLAN สั่งเปลี่ยนเป็น `p_now` ✅ ถูกแล้ว

**CONFIG ของ FB กับ LINE ต่างกันจริง** (ไม่ใช่แค่ค่าคนละตัว แต่คนละโครงสร้าง)

| | FB (`bot-webhook_fixed`) | LINE (`line-webhook` v3.1) |
|---|---|---|
| บอทตอบเมื่อไร | `REPLY.schedule[]` — 3 ช่วง มี mode ต่อช่วง (`immediate` / `wait_human` + `waitMin`) | `REPLY.hours {start:22,end:8}` ช่วงเดียว ไม่มี mode |
| คนตอบแล้วบอทเงียบนานแค่ไหน | `humanOwnsConvoHours: 12` (ชั่วโมง) | `humanHoldMin: 30` (นาที) |
| แจ้งทีมช่วงไหน | 19:00–09:00 · นอกช่วง `skip` | 0–24 · นอกช่วง `send` |
| เตือนซ้ำ | `remindAfterMin: 0` (ไม่ซ้ำ) | `remindAfterMin: 15` |
| watchdog | มี (09–19, 120 นาที) | **ไม่มีเลย** |
| เฉพาะช่องทาง | `standby`, `app_id` ของ echo | `replyToken`, `replyTokenMaxSec: 20`, `[AD:xxx]` prefix, `welcomeOnFollow`, group commands |

PLAN Phase 6 บอกถูกแล้วว่าห้าม hardcode — แต่แปลว่า `bot_schedule` ต้องรองรับ **ทั้งแบบช่วงเดียวและหลายช่วง**
และ `decide_reply` ต้องอ่าน watchdog ที่อาจไม่มีเลยสำหรับ inbox หนึ่ง

### 5.2 ของนอกฐาน

| ต้องการ | ตอนนี้ที่ local |
|---|---|
| `ANTHROPIC_API_KEY` | ❌ ไม่มีใน `.env` ของ asher-connect |
| `OPENAI_API_KEY` (embedding) | ❌ ไม่มี |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | ❌ ไม่มี |
| `RESEND_API_KEY`, `LEAD_EMAIL_TO/FROM` | ❌ ไม่มี |
| `LINE_NOTIFY_GROUP_ID` | ❌ ไม่มี |
| `ADMIN_PSIDS`, `ADMIN_LINE_IDS` | ❌ ไม่มี |
| PAGE / LINE token | ✅ มีใน `channels.json` |
| `pg_cron` | ⚠️ **ยังไม่ได้ `create extension`** แต่มีใน `shared_preload_libraries` แล้ว ติดตั้งได้ทันที |
| `pgvector` | ⚠️ ยังไม่ได้ติดตั้ง (มีให้ติดตั้ง) · ไม่มีตาราง knowledge · **RAG ใช้ไม่ได้เลยตอนนี้** |

---

## 6. คำถามที่ต้องตัดสินก่อน Phase 1

### 6.1 คิวเดียวหรือสองคิว — คำถามที่ใหญ่ที่สุด
`connect_private.delivery` ผูกกับ `message_id` เป็น primary key
แต่ `generate` / `classify` / `notify` ไม่มีข้อความตอนเข้าคิว

ทางเลือก
- **ก.** ตาราง job ใหม่ (`connect_private.job`) ที่มี `kind`/`conversation_id`/`payload`/`send_after`/`target`
  แล้ว `delivery` เดิมกลายเป็นกรณีพิเศษของ `kind='send'` — **กติกาข้อ 2 ได้ครบ** แต่ของเดิมที่ทำงานอยู่ต้องย้าย
- **ข.** ปล่อย `delivery` ไว้เฉพาะข้อความที่มีตัวตนแล้ว แล้วเพิ่มคิวที่สอง — ขัดกติกาข้อ 2 (จุดกันส่งไม่ได้อยู่ที่เดียว)
- **ค.** สร้าง `inbox.message` ล่วงหน้าเป็นสถานะ draft ตอนเข้าคิว `generate` — เลี่ยงคิวใหม่ได้ แต่จะมีข้อความค้างในหน้าจอเซลส์ที่ยังไม่มีเนื้อหา

ผมเสนอ **ก.** — คำถามคือรับได้ไหมที่ต้องแตะ `delivery` ซึ่งมีข้อมูลจริงอยู่ (กติกาข้อ 9 บอกให้ถามก่อน)

### 6.2 `mode` กับ `bot_active` เอาตัวไหน
เสนอ: เพิ่ม `mode text` แล้ว **ลบ `bot_active`** พร้อม migrate ค่า (`bot_active=true → 'bot'`)
ไม่เก็บสองตัว — แต่ต้องเช็คก่อนว่า asher-web อ่าน `bot_active` อยู่ตรงไหนบ้าง

### 6.3 `webhook_log` อยู่ `inbox` หรือ `connect_private`
PLAN เขียน `inbox.webhook_log` · ของจริงอยู่ `connect_private.webhook_log` แล้ว (มี payload ลูกค้าอยู่ข้างใน)
ย้ายไป `inbox` = เบราว์เซอร์มีสิทธิ์เห็นถ้า RLS พลาด · เสนอให้อยู่ที่เดิม

### 6.4 `fbline_report_TG.ts` หายไป
Phase 7 ทั้งเฟสอ้างไฟล์นี้ (`loadReportData`, `buildDailyDigest`, `fmtMin`, `thDate`)
ไม่มีอยู่ใน Downloads — ขอไฟล์ หรือจะให้เขียนใหม่จากสเปกใน PLAN อย่างเดียว?

### 6.5 Phase 6 อ้างของที่ไม่มีในไฟล์อ้างอิง
PLAN พูดถึง `sales_staff`, `sales_staff_identity`, `human_reply_events`, `sales_staff_kpi_daily`,
คำสั่งกลุ่ม `ลงทะเบียน <ชื่อ>` และ `ฉันใคร`
`line-webhook.ts` ที่มีอยู่ **ไม่มีของพวกนี้เลย** (มีแค่ `ตอบแล้ว` / `หยุด` / `บอท` / `สถานะ` / `ไอดีกลุ่ม`)
→ มี `line-webhook` เวอร์ชันใหม่กว่านี้บน cloud ไหม หรือให้ออกแบบใหม่?

### 6.6 RAG (`match_knowledge`) เอาไหมในรอบนี้
ไม่มี pgvector ไม่มีตาราง knowledge ไม่มี OpenAI key
ของเดิมถ้าไม่มี `OPENAI_KEY` จะข้าม RAG แล้วตอบด้วย `PROJECT_DATA` อย่างเดียว (ยังทำงานได้)
เสนอ: **Phase 4 ไม่ทำ RAG** ใช้ `PROJECT_DATA` ก่อน แล้วค่อยเติมทีหลัง — รับได้ไหม

### 6.7 pg_cron ติดตั้งเลยได้ไหม
Phase 3 และ 7 ต้องใช้ · ตอนนี้ยังไม่ได้ `create extension pg_cron`
เป็นการเปลี่ยนฐานที่มีข้อมูลจริง กติกาข้อ 9 จึงต้องถาม
(ทางเลือกอื่น: ใช้ `ops.job_schedule` + Windows Task Scheduler ที่โปรเจกต์นี้ใช้อยู่แล้ว)

### 6.8 `responder_name` เก็บยังไง
คนตอบจาก Business Suite / chat.line.biz ไม่มี uuid ในระบบเรา
เสนอ: คอลัมน์ `responder_label text` บน `inbox.message` แยกจาก `sender_id`
แล้วสถิติรายคนใน Phase 7 ใช้ `coalesce(sender_id::text, responder_label)`

### 6.9 ข้อมูลจริงบน cloud จะย้ายมาด้วยไหม
`customers` / `conversations` / `messages` บน cloud มีบทสนทนาจริงอยู่
PLAN ไม่ได้พูดถึงการ migrate ข้อมูลเก่าเลย — ตั้งใจเริ่มจากศูนย์ที่ local ใช่ไหม
ถ้าใช่ ตอน switchover ประวัติแชทเก่าจะไม่อยู่ในหน้าจอเซลส์

---

## 7. สิ่งที่ยังไม่ได้ทำในเฟสนี้ (ตามที่ PLAN สั่ง)

ไม่มีการแก้ไฟล์ใด ๆ นอกจากไฟล์นี้ · ไม่มี migration · ไม่แตะฐานข้อมูล (อ่านอย่างเดียว)
