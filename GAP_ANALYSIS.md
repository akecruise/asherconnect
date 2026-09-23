# GAP ANALYSIS — asher-connect

วันที่ตรวจ: 2026-09-19
Commit ที่ตรวจ: `c26362b` (branch `fix/worker-resync-test-reset`)
ผู้ตรวจ: Claude Opus 5 — อ่านอย่างเดียว ไม่มีการแก้ไฟล์ใดในรีโป (ไฟล์นี้เป็นไฟล์เดียวที่ถูกสร้าง)

---

## 0. ขอบเขตและวิธีตรวจ

| หัวข้อ | สิ่งที่ทำจริง |
|---|---|
| อ่านโค้ด | `server.mjs` (1,548 บรรทัด, ทั้งไฟล์) · `auth.mjs` · `providers.mjs` · `services/answer-hub/*` · `lib/*` · `bots/*` · `health/health.mjs` |
| อ่าน migration | `sql/` ทั้ง 58 ไฟล์ (สแกน + อ่านเจาะจุด dedupe/retry/lease) · `migrations/20260914-shadow-replay.sql` |
| อ่าน UI | `public/*.js`, `public/*.html` (รายชื่อไฟล์ + เส้นทางที่ `server.mjs` เสิร์ฟจริง) |
| อ่าน scripts | `scripts/*` · `sql/run.mjs` · `sync-channels.mjs` · `verify-sql.mjs` |
| รันจริง | `npm run check` (ผ่าน — ดูข้อ B4) · สแกน git history ทุก branch หา secret pattern |
| **ไม่ได้รัน** | `npm test` — ชุด `tests/http.integration.mjs` เขียนลง Supabase จริงผ่าน docker container ตามที่เขียนไว้ใน header ของไฟล์ ถือเป็นการแก้ state จึงข้ามตามข้อสั่ง "ห้ามแก้" |

### ⚠️ ข้อสังเกตสองข้อก่อนเริ่ม

**1. ไม่มี `PLAN.md` ในรีโปนี้**
ค้นทั้ง repo แล้วไม่พบ `PLAN.md` ไฟล์เดียวที่ใกล้เคียงคือ `.handoff/PLAN-stats-phase1-report.md` ซึ่งเป็นรายงาน Phase 1 ของหน้าสถิติ ไม่ใช่แผนรวม
เอกสารที่ทำหน้าที่ "แผน/สถานะ" จริง ๆ คือ:
- `docs/answer-hub/ROADMAP.md` + `docs/answer-hub/PHASE-STATUS.md` (แผน 30 phase ของ Answer Hub)
- `docs/answer-hub/FINAL-ACCEPTANCE-MATRIX.md`
- `docs/answer-hub/HANDOFF.md` (บันทึก deploy ล่าสุด)
- `README.md` (ภาพรวมระบบ)

ผมใช้เอกสารชุดนี้แทน `PLAN.md`

**2. requirement 10 ข้อยังไม่ถูกวางมา**
ท้าย prompt เป็น placeholder `[วาง requirement 10 ข้อ]` — ยังไม่มีเนื้อ requirement จริง
ส่วน A ด้านล่างจึงยัง **ว่างรอ input** ผมไม่เดา requirement เองเพราะการเดาผิดจะทำให้ทั้งตารางไร้ค่า
ส่วน B (ตรวจเพิ่ม 5 หัวข้อ) ทำครบแล้วและใช้ได้ทันที

---

# ส่วน A — Gap analysis เทียบ requirement 10 ข้อ

> **สถานะ: รอ requirement**
> วาง requirement 10 ข้อมาแล้วผมจะเติมตารางนี้ให้ครบทุกช่อง โดยใช้ฐานหลักฐานที่เก็บไว้แล้วในส่วน B และภาคผนวก

รูปแบบที่จะใช้ต่อหนึ่งข้อ:

| ช่อง | ความหมาย |
|---|---|
| สถานะ | done / partial / missing |
| หลักฐาน | `ไฟล์:บรรทัด` หรือชื่อ table / function / RPC |
| สิ่งที่ขาด | ระบุเป็นงานที่ทำได้จริง ไม่ใช่คำบรรยายลอย |
| ความเสี่ยง | ถ้าไม่ทำแล้วพังยังไง ใครเจ็บ |
| Effort | S (≤1 วัน) · M (2–5 วัน) · L (>1 สัปดาห์ หรือแตะ schema/production) |

| # | Requirement | สถานะ | หลักฐาน | สิ่งที่ขาด | ความเสี่ยง | Effort |
|---|---|---|---|---|---|---|
| 1 | _(รอวาง)_ | | | | | |
| 2 | _(รอวาง)_ | | | | | |
| 3 | _(รอวาง)_ | | | | | |
| 4 | _(รอวาง)_ | | | | | |
| 5 | _(รอวาง)_ | | | | | |
| 6 | _(รอวาง)_ | | | | | |
| 7 | _(รอวาง)_ | | | | | |
| 8 | _(รอวาง)_ | | | | | |
| 9 | _(รอวาง)_ | | | | | |
| 10 | _(รอวาง)_ | | | | | |

---

# ส่วน B — ผลตรวจเพิ่มเติม 5 หัวข้อ

สรุปคะแนนรวมก่อน:

| หัวข้อ | สถานะรวม | ความเสี่ยงคงเหลือ |
|---|---|---|
| B1 Webhook error handling / retry | **done** | ต่ำ |
| B2 Idempotency ของข้อความ | **done (ขาเข้า) / partial (ขาออก Messenger)** | ปานกลาง — ยอมรับได้โดยออกแบบ |
| B3 Secrets ที่หลุดเข้า git | **done — ไม่พบการรั่ว** | ต่ำ (แต่มีความเสี่ยงบนดิสก์) |
| B4 Test coverage | **partial** | **สูง** — ไม่มี CI, ชุดหลักต้องมี DB จริง |
| B5 ความต่าง local ↔ VPS | **partial** | **สูง** — `.env.example` ตกหล่น, doc ค้าง |

---

## B1 — Error handling / retry ของ webhook

**สถานะ: done**

### หลักฐาน

ทางเดินขาเข้าถูกแยกเป็นสองท่อนโดยตั้งใจ: รับ-แล้ว-ตอบ-200 กับ ประมวลผลทีหลัง

| จุด | หลักฐาน |
|---|---|
| ปฏิเสธพร้อม log ทุกกรณี | `server.mjs:116-119` — `webhookFail()` บังคับ log ก่อน throw เสมอ |
| ตรวจลายเซ็นแบบ timing-safe | `providers.mjs:14-20` — `createHmac` + `timingSafeEqual` + เช็ค length ก่อน |
| ตรวจปลายทางก่อนเก็บ | `server.mjs:1197-1199` → `providers.mjs:29-33` `matchesDestination()` — ของที่ส่งผิดบ้านไม่เข้าบันทึกดิบ |
| ลายเซ็นไม่ผ่าน → เก็บหลักฐานลงฐาน ไม่ใช่แค่ stdout | `server.mjs:1173-1178` — RPC `webhook_reject` + `flowHealth.log('signature_fail')` |
| ช่องทางที่ปิดโดยตั้งใจ → ตอบ **200** ไม่ใช่ 503 | `server.mjs:1136-1141` — กัน LINE/Meta ปิด endpoint ทิ้งเองเพราะ fail ติดกัน |
| ช่องทางตั้งค่าไม่ครบ → 503 (ดังพอให้คนเห็น) | `server.mjs:1142` |
| เก็บของดิบแล้วตอบ 200 ทันที | `server.mjs:1213-1220` — RPC `log` → `connect_private.webhook_log` |
| งานจริงอยู่คนละ tick | `server.mjs:855-899` — `processInbound()` / `inboundWorker()` ทุก 3 วินาที (`server.mjs:1512`) |
| **Retry + backoff อยู่ที่ฐาน** | `sql/003_job_worker.sql:389-391` — `status = case when attempts<5 then 'pending' else 'failed' end`, `available_at = now() + least(900, 30*attempts)` วินาที |
| **Crash recovery** | `sql/003_job_worker.sql:364-365` — แถวที่ `processing` เกิน 2 นาที ถูกดีดกลับเป็น `pending` |
| **Lease guard** | `sql/003_job_worker.sql:378-381` — `finish_inbound` โยน `stale_lease` ถ้า lease_id ไม่ตรง กัน worker สองตัวปิดงานเดียวกัน |
| ของดิบไม่ถูกลบตอน fail | `sql/003_job_worker.sql:387` — คอมเมนต์ระบุชัด: ล้มเลิกแค่การประมวลผล ไม่ทิ้งหลักฐาน |
| Retention 30 วัน | `server.mjs:1515-1519` + `sql/003_job_worker.sql:397-400` `sweep` |
| ท่อ media มี retry ของตัวเอง | `server.mjs:773-808` — 3 ครั้ง, backoff `800 * n²` ms, ไม่ retry บน 403/404 (ของหมดอายุ), cap ขนาดไฟล์ |
| งานแถม (profile/media) ยิงทิ้ง ไม่ถ่วงคิว | `server.mjs:869-876` — `.catch()` ครบ ไม่มี unhandled rejection |
| กติกา "ไม่มี catch ไหนที่ทิ้ง error" | `server.mjs:10` — ตรวจแล้วโค้ดทำตามจริง ทุก `catch` รับตัว error และ log |
| Timeout ระดับ server | `server.mjs:1508-1509` — `requestTimeout 30s`, `headersTimeout 10s` |
| Body limit | `server.mjs:1103-1112` (`readBody`) — webhook 1 MB (`server.mjs:1155`), API 256 KB, login 4 KB |

### สิ่งที่ขาด

1. **ไม่มี dead-letter / alert เมื่อ webhook_log ตกไป `failed`**
   หลัง 5 ครั้ง แถวเปลี่ยนเป็น `failed` แล้วเงียบ — ไม่มีกฎใน `inbox.monitor_rule` ที่นับ `webhook_log.status='failed'` (ตรวจแล้วใน `sql/202609172025_health.sql` และ `sql/202609181800_health.sql`)
   → ข้อความลูกค้าที่แปลงไม่สำเร็จ 5 ครั้งจะหายเงียบ
2. **`claim_inbound` หยิบทีละ 1 แถวต่อ tick** (`sql/003_job_worker.sql:367-370` — `limit 1`)
   ที่ 3 วินาที/รอบ = เพดานทฤษฎี ~20 webhook/นาที ต่อ container ถ้าโปรโมชันยิงพร้อมกัน คิวจะยาวขึ้นเรื่อย ๆ โดย `/health` ยังเขียวอยู่ (เพราะ `inboundLastSuccess` ขยับทุกรอบ)
3. **การแจ้งเตือน Telegram ของ health ไม่มี retry** (`health/health.mjs:134-147`) — ยิงครั้งเดียว ล้มแล้ว log ทิ้ง วันที่ Telegram ล่มพร้อมระบบ = ไม่มีใครรู้

### ความเสี่ยง

- ข้อ 1 = **ปานกลาง-สูง**: ข้อความลูกค้าหายแบบเงียบ ไม่มีสัญญาณ เจอตอนลูกค้าโทรมาถามว่าทำไมไม่ตอบ
- ข้อ 2 = **ปานกลาง**: เจอเฉพาะช่วง burst แต่เจอแล้วจะเจอตอนที่แย่ที่สุด (ยิงแอดพอดี)
- ข้อ 3 = **ต่ำ-ปานกลาง**

### Effort

- ข้อ 1: **S** — เพิ่มกฎใน `monitor_rule` + query นับ `failed` ใน `health_queue`
- ข้อ 2: **S** — เปลี่ยน `limit 1` เป็น batch loop แบบเดียวกับ `worker()` ที่ `server.mjs:443-449` (ระวัง: ต้องทดสอบ lease กับ advisory lock ที่ `sql/036:99`)
- ข้อ 3: **S**

---

## B2 — Idempotency ของข้อความ

**สถานะ: ขาเข้า = done · ขาออก = partial (โดยตั้งใจ)**

### ขาเข้า — แน่นมาก

| ชั้น | หลักฐาน |
|---|---|
| Unique key ที่ฐาน | `connect_private.inbound_event` — `unique (inbox_id, event_id)` (ระบุที่ `sql/001_bot_schema.sql:22`, มี guard ว่าต้องมีตารางนี้ที่ `:33-34`) |
| ด่านกันซ้ำจริง | `sql/036_echo_source_from_queue.sql:73-78` — `insert ... on conflict do nothing` แล้ว `if not found then return jsonb_build_object('duplicate', true)` |
| บังคับมี event_id | `sql/036:64` — `raise exception 'invalid_event'` ถ้าว่าง |
| **event_id มาจาก provider ไม่ใช่ที่เราปั้นเอง** | `providers.mjs:96` (LINE `webhookEventId` → fallback `message.id`) · `:186, :201` (Meta `message.mid`) · `:210` (postback `mid`) |
| กรณีที่ provider ไม่ให้ id | `providers.mjs:210, :218` — ปั้นแบบ deterministic `pb:<entry>:<sender>:<timestamp>` / `ref:...` — ยิงซ้ำก้อนเดิมได้ค่าเดิม ✓ |
| Event ที่ไม่มี id ถูกทิ้ง | `providers.mjs:105, :119` — `if (!base.event_id) continue` |
| กันซ้ำชั้นสอง (echo ของเราเอง) | `sql/036:143-205` — เทียบกับข้อความที่เราส่งออกไปเองจากคิว กันไม่ให้ echo กลายเป็นข้อความลูกค้า |
| Race ระหว่าง contact เดียวกัน | `sql/036:99` — `pg_advisory_xact_lock(hash(inbox_id || external_id))` |
| **ผลรวม** | ทำซ้ำทั้งก้อนได้เสมอ — `server.mjs:680-682` ระบุเจตนานี้ไว้ตรง ๆ และโค้ดทำตาม |

### ขาออก — มี 3 ระดับ

| ช่องทาง | Idempotency | หลักฐาน |
|---|---|---|
| **LINE (push)** | ✅ มี `X-Line-Retry-Key` = `message_id` | `providers.mjs:373-376` · จัดการ 409 เป็น `sent` ที่ `:380-382` |
| **LINE (reply token)** | ✅ ไม่ต้องมี — token ใช้ได้ครั้งเดียวโดยธรรมชาติ | `providers.mjs:375` (คอมเมนต์) · `:318-321` `canReplyToken` |
| **Messenger** | ❌ ไม่มี — Meta ไม่มี idempotency key | `providers.mjs:298` |
| ทางแก้ของ Messenger | สถานะ `uncertain` → ไม่ยิงซ้ำอัตโนมัติ ให้คนตัดสิน | `providers.mjs:301-303` (`outcome()`) · `:359-361` (catch ของ `deliver`) · `sql/003_job_worker.sql:407-408` (crash → `uncertain`) · `sql/003:433` (`finish`) |
| Ordering guard | ไม่ส่งข้อความถัดไปถ้ามีข้อความเก่ากว่าค้าง `pending/processing/uncertain` | `sql/003_job_worker.sql:415` (`not exists (... older ...)`) |
| ช่องทางแจ้งทีม | ยอมให้ซ้ำโดยเจตนา — ทีมเห็นสองรอบดีกว่าไม่เห็น | `providers.mjs:299` |
| Lease guard ขาออก | `sql/003_job_worker.sql:432` — `stale_lease` ถ้า lease ไม่ตรง |

### สิ่งที่ขาด

1. **ไม่มีหน้าจอ/สัญญาณสำหรับ delivery ที่ค้างสถานะ `uncertain`**
   ออกแบบไว้ว่า "ให้คนดู" แต่ค้นแล้วไม่พบทั้งใน `public/*.js` และใน `health_queue` ว่ามีที่ไหนแสดงจำนวน `uncertain`
   (`sql/003_job_worker.sql:433` เขียนสถานะนี้ลงไป แต่ไม่มีใครอ่านกลับขึ้นหน้าจอ)
   → ระบบ "ให้คนดู" ที่ไม่มีคนเห็น = ข้อความค้างถาวรและกันข้อความถัดไปทั้ง conversation (เพราะ ordering guard ที่ `sql/003:415` นับ `uncertain` เป็นของค้าง)
   **นี่คือช่องโหว่ที่หนักที่สุดที่เจอในการตรวจรอบนี้**
2. **`runJob` สาขา delivery ใช้ `finishJob()` ผิดคีย์ตอนเกิด exception**
   `server.mjs:489-494` catch แล้วเรียก `finishJob(job, ...)` ซึ่งส่ง `job_id: job.id` (`server.mjs:497-498`)
   แต่งาน delivery มาจาก RPC `claim` ที่คืนแถวของ `connect_private.delivery` ซึ่งคีย์คือ `message_id` ไม่มี `id` (`sql/003_job_worker.sql:413-421`)
   → ถ้า RPC `finish` (`server.mjs:482`) ล้มเพราะเน็ตสะดุด งานจะปิดไม่ลง แถวค้าง `processing` แล้วรอ reclaim 2 นาที ซึ่งสำหรับ Messenger = กลายเป็น `uncertain` ทั้งที่ส่งถึงลูกค้าไปแล้วจริง
   ผลกระทบไม่ใช่ข้อความซ้ำ (ปลอดภัยด้าน correctness) แต่ไปโผล่เป็นงานค้างของข้อ 1
3. **ไม่มี test ที่ยิง webhook ก้อนเดิมสองครั้งแล้ว assert ว่าไม่เกิดข้อความซ้ำ**
   ค้นใน `tests/http.integration.mjs` แล้วไม่พบเคส replay ตรง ๆ — ด่านกันซ้ำที่เป็นหัวใจของระบบจึงไม่มี regression test

### ความเสี่ยง

- ข้อ 1 = **สูง**: ลูกค้าหนึ่งคนอาจเงียบถาวรโดยไม่มีใครรู้ และหาสาเหตุยากมากเพราะไม่มีที่ให้ดู
- ข้อ 2 = **ปานกลาง**: ตัวมันเองไม่ทำข้อมูลเสีย แต่ขยายโอกาสเกิดข้อ 1
- ข้อ 3 = **ปานกลาง**: วันที่มีคนแก้ `receive` แล้วเผลอทำ dedupe พัง จะไม่มีอะไรจับได้

### Effort

- ข้อ 1: **M** — เพิ่มจำนวน `uncertain` เข้า `health_queue` + แถวใน `/admin/health` + ปุ่ม "ยืนยันส่งแล้ว / ส่งซ้ำ"
- ข้อ 2: **S** — แยก finish path ของ delivery ออกจาก job (ใช้ `message_id` + `lease_id`)
- ข้อ 3: **S** — เพิ่มเคสใน `tests/http.integration.mjs` (ยิง payload เดิม 2 ครั้ง, assert `count(*) = 1`)

---

## B3 — Secrets ที่หลุดเข้า git

**สถานะ: done — ไม่พบ secret จริงใน git**

### หลักฐาน

| การตรวจ | ผล |
|---|---|
| สแกนไฟล์ที่ถูก track ทั้งหมด ด้วย pattern `sk-ant-*` / `sk-or-v1-*` / JWT (`eyJhbGciOi…`) / Meta page token (`EAA…`) / Resend (`re_…`) / Telegram bot token (`\d{9,10}:AA…`) / PEM private key | **0 hit** |
| สแกน **ทุก commit ทุก branch** (`git log --all -p`) ด้วย pattern เดียวกัน | เจอ 3 บรรทัด — ทั้งหมดเป็น **placeholder ในเอกสาร** (`sk-ant-api03-xxxxx`, `123456789:AAExxxxx`) ไม่ใช่ค่าจริง |
| ไฟล์ชื่อสุ่มเสี่ยงที่เคยเข้า git | มีเพียง `.env.example`, `channels.example.json`, และ `set-meta-credentials.mjs` (commit `ab88f9f` บน branch `wip/unsorted-20260916` — ไฟล์ว่าง/ไม่มีเนื้อ ตรวจแล้ว) |
| `.gitignore` | `.gitignore:1-8` — `.env*` (ยกเว้น `.env.example`), `channels.json`, `channels.json.*`, `channels_*.json`, `.secrets-archive/`, `.sessions/` — **ครอบไฟล์เสี่ยงในเครื่องครบทุกไฟล์** (ยืนยันด้วย `git status --ignored`) |
| Token ไม่ออกไปถึงเบราว์เซอร์ | `server.mjs:269` (ตรวจ token เกิดฝั่ง server เท่านั้น) · `server.mjs:1060` + `:1087-1092` (`systemExtraTests` รายงานแค่ configured/missing ไม่มีค่า) |
| `providers.mjs` ไม่อ่าน env เอง | `providers.mjs:331` — token มาทาง config เท่านั้น |
| Log ไม่มี payload ลูกค้า | `server.mjs:90` (กติกา) · `server.mjs:771` (media: มีแค่ id กับเหตุผล) — ตรวจแล้วโค้ดทำตาม |
| Image ไม่พา secret เข้าไป | `Dockerfile:3-18` — `COPY` ระบุไฟล์เป็นรายชื่อ ไม่มี `COPY . .` → `.env`/`channels.json` เข้า image ไม่ได้แม้ `.dockerignore` พลาด |

### สิ่งที่ขาด

1. **ไม่มี secret scanner อัตโนมัติ** — ไม่มี pre-commit hook, ไม่มี CI, ไม่มี `gitleaks`/`trufflehog`
   `docs/answer-hub/HARDENING-TODO.md` ยอมรับเองว่า "Phase 19 automated secret scanner remain hardening items"
   ตอนนี้กันได้ด้วย `.gitignore` + วินัยคนอย่างเดียว
2. **`imports/` ไม่อยู่ใน `.gitignore`**
   `imports/asher-facebook-quick-replies-filled-naii.xlsx` เป็น untracked และ **ไม่ถูก ignore** → `git add -A` ครั้งเดียวก็เข้า repo
   ไม่ใช่ credential แต่เป็นข้อมูลธุรกิจ (ราคา/สคริปต์ขายของโครงการ Naii) และ `docs/answer-hub/HANDOFF.md` ระบุว่าต้องกันไม่ให้เข้า deploy archive
3. **ของลับบนดิสก์กระจายหลายไฟล์**
   `.env`, `.env.local`, `.env.bak-beforeTunnel`, `.env.bak-preNotify`, `channels.json`, `channels.json.bak-prerename`, `channels.json.bak4`, `channels_ba22.json`, `channels_test.json`, `.secrets-archive/` (5 ไฟล์)
   ทั้งหมด ignored ถูกต้อง แต่ = สำเนา page access token / service_role key นอน plaintext อยู่ 10+ ที่ในโฟลเดอร์เดียว ไม่มีใครรู้ว่าอันไหนยังใช้ได้อยู่
4. **IP ของ VPS อยู่ในเอกสารที่ track แล้ว** — `docs/deploy.md:29, 55, 56, 80, 90, 100` (`187.53.139.175`)
   ไม่ใช่ secret แต่ถ้ารีโปนี้เคยถูก push ขึ้น public หรือส่งต่อ = เปิดเป้าให้ scan ตรง ๆ

### ความเสี่ยง

- ข้อ 1 = **ปานกลาง**: ตอนนี้สะอาด แต่ไม่มีอะไรกันครั้งหน้า
- ข้อ 2 = **ปานกลาง**: ข้อมูลราคาลูกค้าเข้า git แล้วลบยาก (ต้อง rewrite history)
- ข้อ 3 = **ปานกลาง-สูง**: เครื่อง dev หลุด = token ของเพจจริงหลุดทั้งชุด
- ข้อ 4 = **ต่ำ**

### Effort

- ข้อ 1: **S** — เพิ่ม `gitleaks` เป็น pre-commit + step ใน CI (แต่ต้องมี CI ก่อน ดู B4)
- ข้อ 2: **S** — เพิ่ม `imports/` ใน `.gitignore` (1 บรรทัด)
- ข้อ 3: **S** — รวบ `.env.bak-*` / `channels*.bak*` ที่เลิกใช้ไปไว้นอกโฟลเดอร์ repo แล้วหมุน token ที่ไม่แน่ใจ
- ข้อ 4: **S**

---

## B4 — Test coverage

**สถานะ: partial — ปริมาณเยอะ แต่โครงสร้างเปราะ**

### หลักฐาน — สิ่งที่มี

| ชุด | ไฟล์ | ครอบอะไร |
|---|---|---|
| Unit | `tests/auth.test.mjs` (190 บรรทัด) | เซสชัน, rate limit, refresh race |
| Unit | `tests/providers.test.mjs` (27 KB) | signature, normalize, deliver, outcome mapping |
| Unit | `tests/bots.test.mjs` (17 KB) | reply/classify/notify |
| Unit | `tests/decide.test.mjs`, `tests/outcomes.test.mjs`, `tests/report.test.mjs` | ตรรกะบอท/รายงาน |
| Unit | `tests/media.test.mjs`, `tests/media-http.test.mjs`, `tests/profile.test.mjs` | ท่อ media / profile |
| Unit | `tests/testcmd.test.mjs`, `tests/quick-reply-import.test.mjs`, `tests/quick-replies-ui.test.mjs` | คำสั่ง test, import |
| Service | `tests/answer-hub.service.test.mjs` (392 บรรทัด, S01–S21) | flags, error model, RPC mapping |
| Integration | `tests/http.integration.mjs` (**101 KB**) | ยกเซิร์ฟเวอร์จริง ยิงตามเส้นทางจริง — signature บนสาย, checkOrigin, lease ของ worker |
| SQL selftest | `sql/_selftest/*.sql` (17 ไฟล์) | ต่อ migration |
| Static check | `npm run check` (`package.json:12`) | `node --check` 14 ไฟล์ + `sql/run.mjs check` |
| ตัวเลขอ้างอิง | `docs/answer-hub/HANDOFF.md` — ครั้งล่าสุด 312/312 PASS |

### สิ่งที่ขาด

1. **ไม่มี CI เลย** — ไม่มี `.github/`, `.gitlab-ci.yml`, ไม่มีอะไรทั้งนั้น (ตรวจแล้ว)
   ทุกอย่างพึ่ง "คนรัน `npm test` ก่อน deploy" ซึ่งเอกสาร deploy (`docs/deploy.md`) **ไม่ได้บังคับเป็นขั้นตอนด้วยซ้ำ** — ขั้นตอนที่ 2 ข้ามจาก commit ไป `git archive` ตรง ๆ
2. **ชุดใหญ่ที่สุดต้องมีฐานจริง** — `tests/http.integration.mjs:14-15` ระบุเองว่า "เขียนลงฐานจริง (ไม่มี transaction ให้ rollback)" และคุยกับ DB ผ่าน docker container
   → รันบนเครื่องที่ไม่มี Supabase stack ไม่ได้เลย = เป็นอุปสรรคโดยตรงต่อการมี CI
3. **4 ไฟล์เทสต์ไม่ได้ถูกเรียกใน `npm test`** (`package.json:11`)
   - `tests/sla.test.mjs` — **เป็น unit test แท้ ๆ ที่ควรอยู่ในชุดหลัก แต่ตกหล่น**
   - `tests/notify-test-prefix.test.mjs` (149 บรรทัด) — เช่นกัน
   - `tests/answer-hub.browser.mjs`, `tests/quick-answer.browser.mjs` — ต้องมีเบราว์เซอร์ พอเข้าใจได้
   - `tests/testreset.db.test.mjs` ต้องมี DB (มี script แยก `test:testreset`)
4. **โมดูลที่ไม่มี test เลย**: `health/health.mjs` (307 บรรทัด — ระบบเตือนภัยทั้งระบบ), `sync-channels.mjs` (10 KB), `scripts/*` ทั้งโฟลเดอร์, `services/answer-hub/render.mjs` มีบางส่วน
5. **ไม่มีเทสต์ replay/idempotency** (ดู B2 ข้อ 3) และไม่มีเทสต์ที่ assert ว่า `uncertain` ถูกจัดการ
6. **ไม่มีการวัด coverage** — ไม่มี `c8`/`nyc` ตัวเลข 312 คือจำนวน assertion ไม่ใช่ % coverage
7. **`npm run check` เตือนเรื่องลำดับ migration**
   ผลรันจริงวันนี้: `เตือน: เลข 022 ซ้ำ` (`022_send_mode_switch.sql` / `022_contact_profile_sync.sql`), `เลข 023 ซ้ำ`, `เลข 024 ซ้ำ` + รายการฟังก์ชันที่ถูกทับข้ามไฟล์ (`inbox.ah_save`, `ah_retire`, `ah_versions`, `ah_resolve`, `answer_hub._snapshot_version`)
   → ลำดับ apply บนเครื่องที่ต่างกันอาจได้ definition คนละตัว **โดยผ่าน check**
8. **ขยะ `.bak` ปนอยู่ในโฟลเดอร์ tests** — `http.integration.mjs.bak`, `.bak-preNoAuth`, `tests/stats/*.bak-preStatsV2` (ignored แล้ว แต่ทำให้อ่านยาก)

### ความเสี่ยง

- ข้อ 1+2 = **สูง**: regression หลุดขึ้น production ได้ทุกเมื่อ ระบบนี้ deploy บ่อยมาก (9 commit ใน 2 วัน) และแตะเส้นทางเงินจริง
- ข้อ 3 = **ปานกลาง**: มี test เขียนไว้แล้วแต่ไม่มีใครรัน = ได้ความมั่นใจปลอม
- ข้อ 7 = **ปานกลาง-สูง**: นี่คือประเภทปัญหาที่ทำให้ local ผ่านแต่ production พัง ซึ่งเกิดกับโปรเจกต์นี้มาแล้ว (ดู `HANDOFF.md` เรื่อง `202609180530_source_registry.sql`)

### Effort

- ข้อ 3 (เพิ่ม 2 ไฟล์เข้า `npm test`): **S**
- ข้อ 1 (CI แค่ `npm run check` + unit tests ที่ไม่ต้องใช้ DB): **S**
- ข้อ 2 (แยก `npm test` เป็น `test:unit` ที่ไม่ต้องใช้ DB + `test:db`): **M**
- ข้อ 4 (test ให้ `health.mjs`): **M**
- ข้อ 6 (coverage): **S**
- ข้อ 7 (เรียงเลข migration ใหม่ + บังคับ unique): **M** — ต้องระวังทะเบียน `inbox.sql_applied` บน production

---

## B5 — ความต่างระหว่าง local กับ VPS

**สถานะ: partial — โค้ดตรงกัน แต่ config drift และเอกสารค้าง**

### หลักฐาน — สิ่งที่ตรงกันและออกแบบมาดี

| ด้าน | สถานะ |
|---|---|
| Deploy จาก commit ไม่ใช่ working tree | `docs/deploy.md:3, 38-50` — ใช้ `git archive` ✅ หลักการนี้ถูกต้องมาก |
| ไฟล์ที่ห้ามทับบน VPS | `docs/deploy.md:17` — `.env`, `channels.json`, `.sessions/` และทั้งสามไม่มีใน git จึงไม่มีใน archive ✅ |
| Session ไม่หายตอน deploy | `docker-compose.yml:16` — named volume `connect-sessions` ✅ |
| Compose/Dockerfile เป็นไฟล์เดียวกันทั้งสองฝั่ง | ทั้งคู่ tracked ✅ |
| จดจุดย้อนกลับก่อน deploy | `docs/deploy.md:26-36` — tag image + `cp -a` ✅ |
| **Commit ที่รันบน production** | `6743b45` (`docs/answer-hub/HANDOFF.md` — Saved Replies deployment) |
| **Commit ล่าสุด local** | `c26362b` — ตรวจแล้วเป็น **doc-only** → **โค้ดแอปตรงกันทั้งสองฝั่ง** ✅ |

### สิ่งที่ขาด / ต่างจริง

1. **`.env.example` ตกหล่น 10 ตัวแปรที่โค้ดใช้จริง**
   เทียบ `process.env.*` ทั้งหมดในโค้ด กับ `.env.example` แล้ว ขาด:

   | ตัวแปร | ใช้ที่ | ผลถ้าไม่มี |
   |---|---|---|
   | `CONNECT_CHANNELS_FILE` | `server.mjs:48` | **ไม่มี = ไม่มีช่องทางเลย worker ไม่เดิน** (`server.mjs:437`) — ตัวแปรที่สำคัญที่สุดตัวหนึ่ง |
   | `ANSWER_HUB_ENABLED` | `server.mjs:539`, `services/answer-hub/service.mjs:65` | Answer Hub ปิดเงียบ |
   | `ANSWER_HUB_BOT_ENABLED` | `server.mjs:540` | บอทไม่ใช้คลังคำตอบ |
   | `ANSWER_HUB_LEARNING_ENABLED` | `server.mjs:503` | ไม่เก็บ learning candidate |
   | `ANSWER_HUB_DYNAMIC_DATA_ENABLED` | `service.mjs:66` | — |
   | `ANSWER_HUB_IMPORT_ENABLED` | `service.mjs:69` | — |
   | `TEST_USER_IDS` | `bots/testcmd.mjs:12` | คำสั่ง `test` ใช้ไม่ได้ |
   | `APP_VERSION` | `server.mjs:959` | `/health` รายงาน `version: null` |
   | `SESSION_DIR` | `server.mjs:205` | — |
   | `PUBLIC_URL`, `CONNECT_WORKER_STALE_MS`, `NODE_ENV`, `PORT` | `server.mjs:247, 56, 935, 40` | — |

   `.env.example:1` เขียนว่า "ไฟล์นี้เข้า git ได้ ห้ามมีค่าจริง" — เจตนาถูก แต่ไฟล์ไม่ทำหน้าที่ "รายการตัวแปรที่ครบ" ซึ่งเป็นหน้าที่หลักของมัน
   → คนตั้งเครื่องใหม่จากไฟล์นี้จะได้ระบบที่ **บูตขึ้นแต่ไม่ทำอะไรเลย** และไม่มีอะไรบอกว่าทำไม

2. **`.env` ของ local มีตัวแปรที่ `.env.example` ไม่รู้จัก**
   `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `TELEGRAM_NOTIFY_ALL`
   ค้นในโค้ดแล้ว **ไม่มีที่ไหนอ่านสามตัวนี้เลย** → ตกค้างจากของเดิม ไม่มีใครรู้ว่ายังต้องมีไหม (และ `OPENROUTER_API_KEY` = key จริงนอนอยู่เปล่า ๆ)

3. **Local ไม่ได้ตั้ง `ANSWER_HUB_*` เลย**
   → Answer Hub ที่พัฒนามา 12 phase **ปิดอยู่ทั้ง local และ production** (`HANDOFF.md` ยืนยัน: "Answer Hub feature flags remain unset (default-off)")
   โค้ด path ที่ `server.mjs:539-551` (บอทใช้ Hub ก่อน Claude) **ไม่เคยถูกเดินจริงในสภาพแวดล้อมไหนเลย**

4. **`docs/deploy.md:19` ค้าง — รายการ `COPY` ไม่ตรง `Dockerfile` จริง**
   doc บอก: `package.json server.mjs providers.mjs auth.mjs bots/ reports/ public/ lib/ scripts/`
   `Dockerfile:3-18` จริงมี **`health/` และ `services/` เพิ่ม** และคอมเมนต์ใน Dockerfile เองเตือนว่า "ถ้าลืมบรรทัดนี้ container จะขึ้นไม่ได้เลย"
   → ใครแก้ Dockerfile โดยอ้างอิง doc นี้จะทำ production ล่มทันที

5. **เอกสารสถานะขัดกันเอง**
   - `docs/answer-hub/PHASE-STATUS.md` ตาราง: Phase 13–17 = "NOT STARTED"
   - แต่มี migration จริงครบ: `202609181300_quick_answer.sql`, `202609181400_recommendation.sql`, `202609181600_usage.sql`, `202609181700_feedback.sql` และมี RPC ใน `AH_ACTIONS` (`server.mjs:222`)
   - และหัวข้อ "MVP execution override" ในไฟล์เดียวกันบอก "Phases 13–25 MVP READY"
   - `HARDENING-TODO.md` บอก "Keep production on `97d1b636…`" แต่ `HANDOFF.md` บอกว่า deploy `6895b20` → `b530337` → `6743b45` ไปแล้ว
   → **ไม่มีเอกสารไหนที่เชื่อถือได้ว่าตอนนี้ production เป็นอะไรกันแน่** ต้องไปอ่าน `.deployed-commit` บนเครื่องจริงอย่างเดียว

6. **Branch `fix/worker-resync-test-reset` นำหน้า `master` อยู่ 40 commit**
   `master` ตามหลังทั้งหมด (`git log HEAD..master` = 0) — ของที่รันบน production มาจาก branch นี้ ไม่ใช่จาก `master`
   → `master` ไม่ได้สะท้อนอะไรเลย ถ้าใครเผลอ deploy จาก `master` = ย้อนกลับไปหลายสัปดาห์

7. **การยืนยันหลัง deploy ยังค้างทุกครั้ง**
   `HANDOFF.md` และ `QUICK-REPLY-IMPORT-DEPLOYMENT.md` บันทึกซ้ำ ๆ ว่า "authenticated UI/API smoke could not be completed — production login returned HTTP 403"
   → ทุก deploy ที่ผ่านมายืนยันได้แค่ `/healthz` 200 ไม่มีใครเคยยืนยันว่า **คนล็อกอินเข้าใช้งานได้จริง** หลัง deploy

8. **`deploy-sha-local.txt` + `deploy-*.tar.gz` ค้างอยู่ในโฟลเดอร์** ชี้ commit `97d1b636` ซึ่งเก่ากว่า production ไปมาก — ของหลอกตาที่รอให้ใครหยิบไปใช้ผิด

### ความเสี่ยง

- ข้อ 1 = **สูง**: ตั้งเครื่องใหม่/กู้ระบบจาก `.env.example` แล้วได้ระบบที่เงียบสนิทโดยไม่มี error
- ข้อ 4 = **สูง**: doc ผิดในทางที่ทำให้ container บูตไม่ขึ้น
- ข้อ 5+6 = **สูง**: ตอนเกิดเหตุจริงตีสาม ไม่มีใครรู้ว่าจะ rollback ไปที่ไหน
- ข้อ 3 = **ปานกลาง**: มีโค้ดที่ไม่เคยรันจริงอยู่ในเส้นทางที่ตอบลูกค้า
- ข้อ 7 = **ปานกลาง-สูง**: deploy ที่ทำให้ล็อกอินพังจะไม่ถูกจับ
- ข้อ 2, 8 = **ต่ำ-ปานกลาง**

### Effort

- ข้อ 1 (เติม `.env.example` ให้ครบ + หมายเหตุว่าตัวไหนบังคับ): **S**
- ข้อ 2 (ลบตัวแปรตาย + หมุน `OPENROUTER_API_KEY`): **S**
- ข้อ 4 (แก้ `docs/deploy.md:19`): **S**
- ข้อ 6 (merge branch เข้า `master` หรือเปลี่ยน default branch): **S**
- ข้อ 8 (ลบไฟล์ค้าง): **S**
- ข้อ 5 (รวมเอกสารสถานะเหลือแหล่งเดียว): **M**
- ข้อ 7 (ทำบัญชี smoke-test ที่ล็อกอินได้จริง + เพิ่มเป็นขั้นตอนบังคับใน `docs/deploy.md`): **M**
- ข้อ 3 (เปิด `ANSWER_HUB_*` แบบ staged พร้อม rollback): **L**

---

# ส่วน C — สรุปสิ่งที่ควรทำก่อน เรียงตามผลตอบแทนต่อแรง

| ลำดับ | งาน | อ้างอิง | Effort |
|---|---|---|---|
| 1 | เติม `.env.example` ให้ครบ 10 ตัวแปรที่ขาด โดยเฉพาะ `CONNECT_CHANNELS_FILE` | B5-1 | S |
| 2 | แก้ `docs/deploy.md:19` ให้ตรง `Dockerfile` (เพิ่ม `health/`, `services/`) | B5-4 | S |
| 3 | ทำให้ `uncertain` delivery มองเห็นได้บน `/admin/health` | B2-1 | M |
| 4 | เพิ่ม `tests/sla.test.mjs` + `tests/notify-test-prefix.test.mjs` เข้า `npm test` | B4-3 | S |
| 5 | เพิ่ม `imports/` ใน `.gitignore` | B3-2 | S |
| 6 | CI ขั้นต่ำ: `npm run check` + unit tests ที่ไม่ต้องใช้ DB | B4-1 | S |
| 7 | Alert เมื่อ `webhook_log` ตกไป `failed` | B1-1 | S |
| 8 | รวมเอกสารสถานะ deploy เหลือแหล่งเดียว + merge `master` | B5-5, B5-6 | M |
| 9 | เทสต์ replay webhook ก้อนเดิมสองครั้ง | B2-3 | S |
| 10 | แยก `npm test` เป็น `test:unit` / `test:db` | B4-2 | M |

---

# ภาคผนวก — แผนที่รีโป

## จุดเข้าออกทั้งหมดของระบบ (`server.mjs:1427-1485` `route()`)

| Path | Method | ด่าน |
|---|---|---|
| `/webhooks/:key` | GET (Meta verify) / POST | signature (`providers.mjs:14`) + destination (`:29`) |
| `/health` | GET | ไม่มี — ตอบ 503 ได้จริง (`server.mjs:1435-1438`) |
| `/healthz`, `/api/health/*` | — | `flowHealth.handle` (`health/health.mjs`) |
| `/api/login`, `/api/logout` | POST | `checkOrigin` (`server.mjs:1118-1121`) + rate limit (`auth.mjs:121-136`) |
| `/api/command` | POST | `checkOrigin` + session (`auth.mjs:110-119`) + ทะเบียน action |
| `/api/admin/system-health[/test]` | GET/POST | session + `health_can_view()` ใน SQL |
| `/api/admin/health-rule` | POST | session + `health_can_view()` + admin check ใน `health_rule_save` |
| `/media/*` | GET | session (`lib/media-http.mjs`) |
| static | GET/HEAD | ตารางชื่อไฟล์ตายตัว (`server.mjs:1390-1395`) — ไม่ประกอบ path จาก input |

**หลักการสิทธิ์ที่ระบบนี้ยึด (ตรวจแล้วทำจริงทุกจุด):** ด่านสิทธิ์อยู่ใน SQL ไม่ใช่ใน Node
`server.mjs` ทำแค่กันเรียกฟังก์ชันนอกทะเบียน (`STATS_ACTIONS:211`, `LOG_ACTIONS:216`, `AH_ACTIONS:222`)
คำสั่งจากหน้าเว็บวิ่งด้วย token ของคนที่ล็อกอิน (`rpcDirect(accessToken, …)`) ไม่ใช่ service key — `auth.uid()` ในฐานจึงเป็นคนจริง
มีข้อยกเว้นที่ตรวจสิทธิ์ใน Node เพิ่ม: `quick_reply_*` (`server.mjs:1301, 1306, 1311`) ตรวจ `role !== 'admin'` — เป็นชั้นเสริม ไม่ได้แทน SQL

## ชั้นของ `server.mjs`

| บรรทัด | ชั้น |
|---|---|
| 37–98 | ตั้งค่า + log |
| 100–119 | ข้อผิดพลาด (`safeCodes` `:107` — code ที่ยอมให้ออกไปถึงเบราว์เซอร์) |
| 121–236 | คุยกับ Supabase (`callSupabase` แยก AUTH/DATA layer `:132`) |
| 238–373 | health ของช่องทาง (cache 10 นาที, single-flight `:358`) |
| 375–673 | คิวขาออก (worker, generate, classify, notify) |
| 675–899 | คิวขาเข้า (profile, media, `processInbound`, `inboundWorker`) |
| 901–1094 | health ของโพรเซส + สถานะรวมระบบ |
| 1096–1485 | HTTP routing |
| 1487–1548 | bootstrap + timers + SIGTERM |

## Timer ทั้งหมด

| Timer | รอบ | บรรทัด |
|---|---|---|
| `worker` (ขาออก) | 3 วิ | `server.mjs:1511` |
| `inboundWorker` (ขาเข้า) | 3 วิ | `server.mjs:1512` |
| `sweep` (ลบ webhook_log > 30 วัน) | 6 ชม | `server.mjs:1515` |
| `sessions.sweep` | 10 นาที | `server.mjs:1522` |
| `refreshSystemStatus` | 15 วิ | `server.mjs:1535` |
| `flowHealth.start()` | 1 นาที / 1 ชม | `server.mjs:1530` |
| `refreshProfiles` | ≥10 นาที (gate ในฐาน) | `server.mjs:728-731` |

ทุกตัว `.unref()` และถูก clear ใน SIGTERM (`server.mjs:1539-1548`) ✅

## สิ่งที่ทำได้ดีเป็นพิเศษ (บันทึกไว้เพื่อไม่ให้ใครเผลอรื้อ)

- **โหมดเงากันด้วยโครงสร้าง ไม่ใช่ `if`** — `server.mjs:462-463` ไม่ขอ job ชนิด `send` มาตั้งแต่แรก → `attempts` ไม่ขยับ ลำดับไม่เสีย เปิดโหมดกลับแล้วของค้างถูกส่งตามลำดับเดิมครบ
- **`refreshSendMode` ล้มแล้วคงโหมดเดิม ไม่ fallback** — `server.mjs:420-433` เหตุผลเขียนไว้ชัด (fallback ไป "ส่งจริง" = ข้อความหลุดหาลูกค้าตอนฐานสะดุด)
- **`/health` ยอมตอบ 503 จริง** — `server.mjs:1437`
- **แยก AUTH/DATA layer ตอนแปล error** — `server.mjs:121-168` แก้ปัญหา "เซสชันหมดอายุถูกแปลงเป็น บันทึกไม่สำเร็จ"
- **Refresh token single-flight** — `auth.mjs:86-102` กันเซสชันตายเพราะหมุน token ชนกัน
- **CSP + security headers ครบ** — `server.mjs:1490-1493`
- **คอมเมนต์อธิบาย "ทำไม" ไม่ใช่ "อะไร"** ทั่วทั้งโค้ด และเกือบทุกจุดอ้างเหตุการณ์จริงที่เคยพัง — นี่คือทรัพย์สินของโปรเจกต์นี้
