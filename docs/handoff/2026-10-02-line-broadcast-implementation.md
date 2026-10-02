# Handoff — ตัวส่ง LINE หลายคน + API ให้ CRM (ลงมือแล้ว, ยังไม่ deploy)

วันที่ 2026-10-02 · branch `feature/line-broadcast-sender` · ใบงาน: `docs/handoff/2026-10-02-line-broadcast-sender.md`

> ★★ **ยังไม่ deploy · ยังไม่รัน SQL บน VPS · `LINE_BROADCAST_LIVE` ยังไม่ถูกเปิด**
> โค้ดอยู่ใน branch เท่านั้น ของบน production ยังเป็น `4a5482d` เหมือนเดิม

## สิ่งที่มีอยู่แล้วก่อนเริ่ม (สำรวจแล้ว ไม่ได้เขียนใหม่)

| เรื่อง | สถานะเดิม |
|---|---|
| ดาว · tag · หน้ารายชื่อติดต่อ | **มีจริงและขึ้น production แล้ว** — `connect_private.contact_flag` / `tag` / `contact_tag`, `inbox.contacts_list` / `contact_detail`, `lib/case-flags.mjs` → ไม่แตะ |
| follow / unfollow | `connect_private.receive_event` ติดธง `core.contact.blocked` + เขียน message `event_type='follow'/'unfollow'` อยู่แล้ว (sql/036) — แต่เป็นระดับ "คน" รวมทุกช่องทาง |
| ส่ง LINE | `providers.mjs sendLine()` มี push/reply + `X-Line-Retry-Key` + 409→sent + 403→blocked ครบแล้ว · **ไม่มี multicast / quota** |
| outbox ไป CRM | `inbox.crm_publish_outbox` + `crm_publish_claim/finish/stats` + trigger มีในฐาน (sql/202609211300) |
| ปุ่ม "ส่ง LINE หลายคน" | มีใน UI แต่ `narrowcastBlocked()` ปิดไว้ (`public/app.js:1041`) · เมนู `nav-broadcast` disabled |

### ⚠️ ของที่หายไปและเป็นเหตุให้ต้องตัดสินใจ

**`crmPublisherWorker` ไม่อยู่ใน `server.mjs` แล้ว** — commit `20a7799` ("snapshot: production release") เอาโค้ดจาก VPS กลับเข้า repo และลบไป −870 บรรทัด รวมทั้งตัวดูด outbox ทั้งก้อน (เดิมอยู่ใน `8295043`)

ผลที่ตามมา: trigger ยังเขียนแถวเข้า `inbox.crm_publish_outbox` บน VPS แต่**ไม่มีใครดูด** น่าจะมี `pending` ค้างสะสมอยู่

**ผู้ใช้ตัดสินเมื่อ 2026-10-02: เขียนเข้า outbox อย่างเดียว ไม่กู้ worker ในงานนี้** → งานนี้จึง publish event ลงคิวตามสเปก แต่ event จะยังไม่ถึง CRM จนกว่าจะมีคนกู้ตัวดูดกลับมา (เป็นงานแยก)

## สิ่งที่ทำในงานนี้

### 1. `sql/202610021200_line_broadcast.sql` (ใหม่, additive, รันซ้ำได้)

ต่อท้าย `sql/ORDER.txt` แล้ว · **ไม่แตะ `connect_private.api` และไม่แตะ `connect_private.receive_event`**

| ของ | หน้าที่ |
|---|---|
| `alter ... crm_publish_outbox_event_type_check` | เปิดทางให้ event ชนิดใหม่ 3 ตัวเข้าคิวเดิมได้ (ของเดิมยังผ่านเท่าเดิม) |
| `connect_private.channel_follow` | สถานะ follow ล่าสุดต่อ `(inbox_id, external_user_id)` + ดัชนี + RLS |
| `inbox.broadcast_follow_track()` + `trg_broadcast_follow_track` | ทริกเกอร์ after insert บน `inbox.message` — เห็น `event_type` follow/unfollow แล้วอัปเดตสถานะ + publish `channel_identity.follow_changed` · **กลืน exception ของตัวเองทั้งหมด** แบบ `trg_crm_publish_message` ข้อความลูกค้าห้าม rollback เพราะงานนี้พัง |
| backfill | เติมสถานะย้อนหลังจาก message ที่มีอยู่ (แถวล่าสุดต่อคนชนะ) |
| `connect_private.broadcast_job` / `broadcast_batch` / `broadcast_recipient` | ตามสเปกข้อ 2 · `retry_key uuid` สร้างครั้งเดียวตอนรับงาน |
| `inbox.broadcast_enqueue` | รับงาน idempotent · ตัดคน unfollow เป็น `skipped` · แบ่ง batch ≤500 |
| `inbox.broadcast_next_job` / `job_start` / `job_fail` | ให้ Node เช็คโควตาก่อนปล่อยส่ง |
| `inbox.broadcast_claim_batch` | `FOR UPDATE SKIP LOCKED` + lease |
| `inbox.broadcast_batch_finish` / `broadcast_complete` | เก็บผล + publish `broadcast.batch_result` / `broadcast.completed` |
| `inbox.broadcast_status` / `broadcast_cancel` | อ่านสถานะ · ยกเลิกเฉพาะ batch ที่ยังไม่ส่ง |
| `inbox.broadcast_recent_messages` / `broadcast_contact_profile` | อ่านอย่างเดียวให้ CRM |

**สิทธิ์: grant ให้ `service_role` เท่านั้น** — `authenticated` เรียกไม่ได้เลย ทางเข้าคือ `/internal/*` ด้วย `CONNECT_SERVICE_TOKEN` ไม่ใช่ login ของพนักงาน (มีเทสต์ยืนยันทุกตัว)

`event_id` ของทุก event เป็นค่า deterministic (`retry_key` ของ batch / `id` ของ job / `id` ของ message) ยิงซ้ำจึงไม่เกิดแถวที่สองในคิว

### 2. `lib/broadcast.mjs` (ใหม่) — ตรรกะล้วน ไม่ต่อฐาน ไม่ยิงเน็ต ไม่อ่าน env

`tokenMatches` (constant-time, hash ความยาวด้วย) · `bearerToken` · `validateMessages` · `normalizeRecipients` (+ โหมด test) · `parseAllowlist` · `chunkRecipients` · `classifyMulticast` · `quotaAllows` · `backoffSeconds`

### 3. `providers.mjs` — เพิ่มสองฟังก์ชัน (ไม่แก้ของเดิมแม้แต่บรรทัดเดียว)

- `sendMulticast({to, messages, retryKey, accessToken}, fetcher)` → คืนผลดิบ ไม่ตัดสินใจเอง
- `lineQuota({accessToken}, fetcher)` → `{limit, used, remaining}` · `type:'none'` = ไม่จำกัด → `limit: null`

แยกจาก `deliver()` โดยตั้งใจ: `deliver` ผูกกับ `message_id` หนึ่งแถวเสมอ ยัด broadcast รวมเข้าไปจะทำให้สถิติการตอบ/SLA นับ broadcast เป็น "การตอบลูกค้า"

### 4. `server.mjs` — `/internal/*` + `broadcastWorker`

```
POST /internal/broadcasts                      → {job_id, accepted, skipped[], reused, dry_run}
GET  /internal/broadcasts/:id                  → สถานะ + ยอด + รายการ batch
POST /internal/broadcasts/:id/cancel           → {cancelled_batches, status}
GET  /internal/line/quota?channel_key=         → {limit, used, remaining}
GET  /internal/contacts/:ref/recent-messages   → ?limit=20 · ไม่คืนเคส is_test
GET  /internal/contacts/:ref/profile           → avatar / ชื่อ / follow ต่อช่องทาง
```

- ด่าน: `CONNECT_SERVICE_TOKEN` เทียบแบบ constant-time · **ไม่ตั้ง = ประตูปิดสนิท** (ไม่ใช่เปิดให้ทุกคน)
- อยู่ก่อน `/api/` และ **ไม่ผ่าน `checkOrigin`** โดยตั้งใจ — ผู้เรียกคือ CRM ในวงใน ไม่ใช่เบราว์เซอร์
- rate limit ต่อ token แบบ fixed window (`CONNECT_SERVICE_RATE_MAX`, ค่าตั้งต้น 120/นาที)
- log บันทึกแค่ id กับจำนวน — ไม่มีเนื้อความและไม่มี userId เต็มลง log
- `broadcastWorker` เดินทุก 5 วินาที: งานที่ยังไม่เริ่ม → เช็คโควตา → `sending` → claim batch → ยิง → เก็บผล
- `/admin/health` เพิ่มก้อน `broadcast: {live, serviceTokenSet, testAllowlist, lastSuccess}` (ไม่ถ่วง `ok`)

### 5. โหมดปลอดภัย

```js
const broadcastLive = process.env.LINE_BROADCAST_LIVE === '1'
```
เขียนเป็น allowlist ไม่ใช่ blocklist — `undefined` `''` `'0'` `'true'` `'yes'` `'1 '` ทั้งหมดแปลว่า **dry run**
dry run ไม่แตะ network แม้แต่การถามโควตา และ log `broadcast_dry_run` ทุกชุด

## env ใหม่

| ชื่อ | ค่าที่ต้องตั้งบน VPS | ความหมาย |
|---|---|---|
| `CONNECT_SERVICE_TOKEN` | สุ่มยาว ≥32 ตัว (ตัวเดียวกับที่ตั้งใน CRM) | ด่านของ `/internal/*` · ไม่ตั้ง = ประตูปิด |
| `LINE_BROADCAST_LIVE` | **ไม่ต้องตั้ง** (= dry run) | `'1'` เท่านั้นที่ส่งจริง — เปิดเมื่อผู้ใช้สั่ง |
| `BROADCAST_TEST_ALLOWLIST` | userId คั่นด้วย `,` | `test:true` ส่งได้เฉพาะคนในลิสต์ · ไม่ตั้ง = ส่งทดสอบไม่ได้เลย |
| `CONNECT_SERVICE_RATE_MAX` | ไม่ต้องตั้ง (120) | เพดานคำขอ `/internal/*` ต่อนาที |

## ผลการทดสอบ (รันแล้ว)

```
node --test tests/broadcast.test.mjs                    → 18/18 ผ่าน
ALLOW_DB_TESTS=1 node --test tests/broadcast.db.test.mjs → ผ่าน (ยิงฐาน supabase-db ในเครื่อง, BEGIN...ROLLBACK)
node sql/run.mjs check                                   → ตรวจผ่าน
```

ครอบคลุมทุกข้อในหัวข้อ Test ของใบงาน: token ผิด/ว่าง/ไม่ตั้ง · idempotency ซ้ำไม่สร้าง job ใหม่ · batching 0/1/500/501/1234 · crash หลัง batch 2 แล้วรันใหม่ (batch 1–2 ไม่ถูกส่งซ้ำ, batch 3 ใช้ retry key เดิม, lease หมดแล้วหยิบใหม่ได้) · 409=sent, 429/5xx/timeout=retry + backoff, เกิน 6 ครั้ง=failed, 400/403=failed · โควตาไม่พอ=ไม่ส่งเลย · dry run ไม่ยิง network (stub fetch แล้ว assert ไม่ถูกเรียก) · recent-messages ไม่คืน is_test · ผลลัพธ์ไม่มี token · สิทธิ์ `authenticated`/`anon` เรียกไม่ได้

### ⚠️ ด่าน `npm test` แดงอยู่ก่อนงานนี้ — ไม่ได้แก้ (ผู้ใช้ตัดสิน 2026-10-02: แก้ `ORDER.txt` อย่างเดียว)

ยืนยันว่าไม่เกี่ยวกับงานนี้: `providers.mjs` มี 0 บรรทัดที่ถูกลบ (`git diff HEAD` = 1 hunk ต่อท้ายไฟล์) · ไฟล์ที่ล้มทั้งหมดไม่ได้ถูกแก้ในงานนี้

| ไฟล์ | อาการ |
|---|---|
| `tests/profile.test.mjs:121` | `'not_found' !== 'ok'` — Messenger participants fallback (`&&` ของ `npm test` หยุดตรงนี้) |
| `tests/providers.test.mjs:34` | Instagram ยิง `/me/messages` แต่เทสต์คาด `/17841426509548035/messages` |
| `tests/media-http.test.mjs` | `lib/media-http.mjs` ไม่ export `createPublicMediaHandler` — อีกหนึ่งของที่หายตอน snapshot `20a7799` |
| `tests/report.test.mjs` · `outcomes` · `decide` (11 ข้อ) | ข้อมูลใน `supabase-db` ของเครื่อง drift (`ฐานได้ 5 · นับใหม่ได้ 6`) |
| `node tests/http.integration.mjs` | ต้องมี `.env` ในโฟลเดอร์ (ไม่มีในเครื่องนี้) |

`sql/run.mjs check` เดิมก็แดง (`202609270700_line_oa_history_archive.sql`, `202609271000_quick_reply_qualification.sql` ไม่อยู่ใน `ORDER.txt`) — **แก้แล้วในงานนี้** เติมเข้าทะเบียนพร้อมหมายเหตุ

## ข้อจำกัดที่ต้องเขียนไว้ใน UI ของ CRM

- multicast **ส่งไม่ถึงคนที่บล็อก แต่ LINE ไม่บอกว่าใคร** — ยอด "ส่งแล้ว" คือ "LINE รับคำขอ" ไม่ใช่ "ลูกค้าอ่านแล้ว"
- คนที่ Connect รู้ว่า unfollow จะถูกตัดเป็น `skipped` ก่อนส่ง แต่คนที่บล็อกโดยไม่เกิด event unfollow จะยังอยู่ในยอด `sent`
- ยกเลิกได้เฉพาะ batch ที่ยังไม่ถูกยิง — ของที่ LINE รับไปแล้วเรียกคืนไม่ได้

## ค้าง — ต้องให้ผู้ใช้ตัดสิน/ทำ

| # | เรื่อง | ต้องการอะไร |
|---|---|---|
| 1 | **รัน SQL + deploy** | `sql/202610021200_line_broadcast.sql` ต้อง backup ก่อนแล้วรันมือบน VPS ตาม `docs/deploy.md` · ยังไม่ได้ทำตามคำสั่ง |
| 2 | **กู้ `crmPublisherWorker`** | event ที่งานนี้เขียนลง `inbox.crm_publish_outbox` จะไม่ถึง CRM จนกว่าจะกู้ตัวดูดกลับมา (โค้ดเดิมอยู่ที่ `git show 8295043 -- server.mjs`) · ควรเช็คจำนวน `pending` ที่ค้างบน VPS ก่อนเปิด ไม่งั้นจะยิง backlog ทั้งก้อนเข้า CRM ทีเดียว |
| 3 | **เปิด `LINE_BROADCAST_LIVE=1`** | ยังเป็น dry run · เปิดเมื่อทดสอบ `test:true` กับ allowlist ผ่านแล้วเท่านั้น |
| 4 | OA ไหน + เพดานต่อครั้ง | ★ โควตา: OA `@wdq0911k` รีช 2,690 แต่ฟรี 300/เดือน → `quotaAllows` จะปฏิเสธทั้งงานถ้าเกิน ต้องให้ CRM แสดงจำนวนเทียบโควตาก่อนกดส่ง |
| 5 | thumbnail ของ recent-messages | ตอนนี้คืน `media: [{path, mime}]` ไม่ใช่ URL — `/media/<path>` ของ Connect ต้องมี session ของพนักงาน CRM จึงยังดึงรูปตรงไม่ได้ ต้องตัดสินว่าจะทำลิงก์เซ็นชื่อ (แบบ `createOutboundMediaUrl`) หรือให้ CRM ฝัง iframe |
| 6 | `contact_ref` คืออะไรแน่ | งานนี้ใช้ `core.contact.id` (uuid) — ต้องยืนยันกับฝั่ง CRM ว่าตรงกับที่ CRM เก็บไว้จาก event |
| 7 | เปิดปุ่มใน UI ของ Connect? | `narrowcastBlocked()` ยังปิดอยู่ตามเดิม — ตาม BOUNDARIES หน้าจอ campaign เป็นของ CRM จึงไม่ได้แตะ ถ้าต้องการปุ่มใน Connect ต้องตัดสินใหม่ |
| 8 | `docs/handoff/2026-09-30-release-gates.md` | ใบงานสั่งให้อ่าน แต่ไฟล์ไม่มีในรีโป |

## ไฟล์ที่แตะ

ใหม่: `sql/202610021200_line_broadcast.sql` · `lib/broadcast.mjs` · `tests/broadcast.test.mjs` · `tests/broadcast.db.test.mjs` · ไฟล์นี้
แก้: `server.mjs` (+223) · `providers.mjs` (+59 ต่อท้าย) · `sql/ORDER.txt` · `package.json` · `docs/BOUNDARIES.md`
