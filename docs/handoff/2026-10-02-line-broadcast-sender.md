# งาน: ตัวส่ง LINE หลายคน + API ให้ CRM (ฝั่ง asher-connect)

วันที่ 2026-10-02 · อ่าน `docs/BOUNDARIES.md` ก่อนเริ่ม · งานคู่กันฝั่ง CRM: `asher-crm/docs/handoff/2026-10-02-customer360-and-line-broadcast.md`
Connect **ไม่มีหน้าจอ campaign** — หน้าจออยู่ใน CRM · Connect เป็นตัวส่ง เจ้าของ token และสถานะ follow

## ก่อนเริ่ม (ห้ามข้าม)

- working tree อยู่บน `claude/mojibake-alert-handoff-mqmhsg` มี WIP — **ห้าม reset/checkout ทับ ห้าม deploy dirty tree** ทำบน branch ใหม่ `feat/line-broadcast-sender` จาก commit ที่ deploy อยู่บน VPS
- **ห้ามเขียนทับ `connect_private.api`** (ตัวบน VPS ใหม่กว่า repo) — ใช้ฟังก์ชันแยกแบบ `rpcDirect` เหมือน `queue_counts` / `media_library_*`
- อ่าน: `server.mjs` (crmPublisherWorker, handleCommand), `lib/crm-publisher.mjs`, `providers.mjs` (การส่ง LINE ปัจจุบัน), `sql/ORDER.txt`, `sql/run.mjs`, `docs/handoff/2026-09-30-release-gates.md`, `docs/handoff/2026-10-01-star-follow-tags.md`
- token อ่านจาก `channels.json` ผ่านโค้ดเดิมเท่านั้น ห้ามลง DB/log

## 1. สถานะ follow / unfollow
- ตรวจว่าเก็บ event `follow` / `unfollow` ของ LINE แล้วหรือยัง ถ้ายัง: เก็บสถานะล่าสุดต่อ `(channel_key, external_user_id)` (+ เวลา) แบบ additive
- publish event `channel_identity.follow_changed` เข้า outbox เดิม เพื่อให้ CRM ตัดคน unfollow ออกจากกลุ่ม

## 2. ตาราง job (schema `connect_private`, additive, รันซ้ำได้)
- `broadcast_job`: id, idempotency_key unique, channel_key, messages jsonb, requested_by (CRM actor), crm_campaign_id, status `queued|sending|sent|partially_failed|failed|cancelled`, recipient_count, sent_count, failed_count, skipped_count, timestamps
- `broadcast_batch`: job_id, batch_no, retry_key uuid (สร้างครั้งเดียว ห้ามเปลี่ยน), status, http_status, line_request_id, attempts, next_attempt_at, error
- `broadcast_recipient`: job_id, external_user_id, batch_no, status `queued|sent|failed|skipped`, reason · PK (job_id, external_user_id)

## 3. Service endpoints (ยืนยันตัวด้วย token แยก `CONNECT_SERVICE_TOKEN` จาก CRM, เทียบแบบ constant-time, ไม่ผ่าน login ผู้ใช้)
- `POST /internal/broadcasts` `{idempotency_key, channel_key, messages[1..5], recipients[{contact_ref, external_user_id}], crm_campaign_id, requested_by, test?:bool}` → `{job_id, accepted, skipped:[{id,reason}]}`
  - ตรวจ: channel_key เป็น LINE ที่มีใน channels.json, ข้อความเป็น text/image ที่ถูกรูปแบบ, รูปเป็น https
  - ตัดคน unfollow/block ฝั่ง Connect อีกชั้น (ข้อมูลล่าสุดอยู่ที่นี่) → status `skipped`
  - idempotency_key ซ้ำ → คืน job เดิม ไม่สร้างใหม่
  - `test=true` → ยอมรับได้ไม่เกิน 5 คน และต้องเป็น is_test หรือ id ที่ตั้งไว้ใน env `BROADCAST_TEST_ALLOWLIST`
- `GET /internal/broadcasts/:id` → สถานะ + ยอด
- `POST /internal/broadcasts/:id/cancel` → ยกเลิกเฉพาะ batch ที่ยังไม่ส่ง
- `GET /internal/line/quota?channel_key=` → `GET /v2/bot/message/quota` + `/quota/consumption` → `{limit, used, remaining}`
- `GET /internal/contacts/:ref/recent-messages?limit=20` → ข้อความล่าสุดทุกช่องทางของลูกค้า (direction, text/ประเภทสื่อ+thumbnail, ผู้ตอบ, เวลา, channel, conversation_id) — อ่านอย่างเดียว ไม่รวมเคส is_test เว้นแต่ขอ
- `GET /internal/contacts/:ref/profile` → avatar url, ชื่อช่องทาง, follow status ต่อช่องทาง
- rate limit ต่อ token, log แค่ id/จำนวน ห้าม log เนื้อหาข้อความหรือ userId เต็ม

## 4. Worker ส่ง (ใน server.mjs แบบ crmPublisherWorker)
- claim job/batch ด้วย `FOR UPDATE SKIP LOCKED` + lease
- ตัดเป็นชุดละ ≤ 500 userIds → `POST https://api.line.me/v2/bot/message/multicast` พร้อม header `X-Line-Retry-Key: <batch.retry_key>`
- 200 → sent · 409 (retry key เดิม = LINE รับไปแล้ว) → sent · 429/5xx/timeout → backoff (ใช้ retry key เดิม) สูงสุด 6 ครั้ง · 400/403 → failed + เก็บ error body
- ก่อนเริ่ม job เช็ค quota ถ้า recipient > remaining → `failed` reason `quota_exceeded` ไม่ส่งบางส่วน
- **โหมดปลอดภัย**: ถ้า `LINE_BROADCAST_LIVE` ไม่ใช่ `1` → mock sender (ไม่ยิง network, ถือว่าสำเร็จ, log `dry_run`) — ค่า default บน VPS ต้องเป็น dry run จนผู้ใช้สั่งเปิด
- ทุก batch เสร็จ → publish `broadcast.batch_result` (job, batch, รายชื่อ sent/failed) และจบ job → `broadcast.completed` เข้า outbox ไป CRM
- ข้อจำกัดของ LINE: multicast ส่งไม่ถึงคน block แต่ API ไม่บอกว่าใคร — ยอด "ส่งแล้ว" คือ "LINE รับคำขอ" ไม่ใช่ "อ่านแล้ว" ให้ระบุใน UI/เอกสาร

## 5. หน้าแชท (Sales Workspace) — ดาว + tag จาก CRM
- แทนส่วนดาว/tag ใน spec 2026-10-01: การ์ดเคสและหัวแชทแสดง ★ และชิป tag โดยเรียก CRM `GET /api/crm/contacts/by-connect/{ref}/flags` (ครั้งเดียวต่อหน้าสำหรับทุกการ์ด) และกดติด/ถอดผ่าน `POST .../tags`, `.../star` ส่ง profile id ของคนกด
- CRM ล่ม → ซ่อนชิปแบบเงียบ ๆ แชทต้องใช้ได้ปกติ
- ส่วนการติดตาม (follow_up_at → crm.activity) ทำตาม spec เดิม

## Test
- signature/token ผิด → 401 · idempotency ซ้ำไม่สร้าง job ใหม่
- batching 0 / 1 / 500 / 501 / 1234 คน
- crash หลัง batch 2 แล้วรันใหม่ → ไม่ส่ง batch 1–2 ซ้ำ, batch 3 ใช้ retry key เดิม
- 409 = sent, 429 retry, 400 failed, quota ไม่พอไม่ส่งเลย
- dry run ไม่ยิง network (stub fetch แล้ว assert ไม่ถูกเรียก)
- recent-messages ไม่คืนเคส is_test, ไม่รั่ว token

## Definition of done
migration ใหม่ต่อท้าย `sql/ORDER.txt` + `node sql/run.mjs check` + `npm test` ผ่าน + HANDOFF (env ใหม่: `CONNECT_SERVICE_TOKEN`, `LINE_BROADCAST_LIVE`, `BROADCAST_TEST_ALLOWLIST`; ขั้นตอน deploy ตาม `docs/deploy.md` โดยต้องรัน SQL ด้วยมือ + backup ก่อน) · **ห้าม deploy ห้ามรัน SQL บน VPS ห้ามเปิด `LINE_BROADCAST_LIVE` — หยุดและรายงานให้ผู้ใช้ตัดสิน**
