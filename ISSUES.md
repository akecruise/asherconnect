# รายงานสรุปปัญหา — asher-connect

วันที่ตรวจ: 2026-09-19 · commit `c26362b` · branch `fix/worker-resync-test-reset`
วิธีตรวจ: อ่านโค้ดทั้งหมด + สแกน git history + `npm run check` — **ไม่ได้แก้ไฟล์ใดในรีโป**
รายละเอียดเต็มพร้อมหลักฐานรายบรรทัด: `GAP_ANALYSIS.md`

---

## สรุปหนึ่งย่อหน้า

โค้ดแกนของระบบนี้คุณภาพสูงผิดคาด — ท่อขาเข้ากันซ้ำแน่นถึงระดับฐาน, retry/backoff/lease ครบ,
signature ตรวจแบบ timing-safe, ด่านสิทธิ์อยู่ใน SQL ไม่ใช่ใน Node, และ git ไม่มี secret รั่วแม้แต่ตัวเดียว
**ปัญหาเกือบทั้งหมดไม่ได้อยู่ที่ตรรกะ แต่อยู่ที่ "ของที่ออกแบบไว้แล้วแต่ไม่มีใครเห็น"**
— สถานะ `uncertain` ที่ไม่มีหน้าจอ, `.env.example` ที่ไม่ครบ, เอกสาร deploy ที่ค้าง, และการไม่มี CI เลย
รวม 21 ปัญหา: **สูง 5 · ปานกลาง 12 · ต่ำ 4**

---

## ตารางรวม

| ID | ปัญหา | ระดับ | Effort | อ้างอิง |
|---|---|---|---|---|
| **P1** | `uncertain` delivery ไม่มีที่ให้ดู → แชทเงียบถาวร | 🔴 สูง | M | `GAP_ANALYSIS.md` B2-1 |
| **P2** | `.env.example` ขาด 10 ตัวแปรที่โค้ดใช้จริง | 🔴 สูง | S | B5-1 |
| **P3** | `docs/deploy.md:19` รายการ `COPY` ไม่ตรง `Dockerfile` จริง | 🔴 สูง | S | B5-4 |
| **P4** | ไม่มี CI เลย — ทุกอย่างพึ่งวินัยคน | 🔴 สูง | S→M | B4-1 |
| **P5** | เอกสารสถานะ deploy ขัดกันเอง + `master` ตามหลัง 40 commit | 🔴 สูง | M | B5-5, B5-6 |
| P6 | ไม่มี alert ตอน `webhook_log` ตกเป็น `failed` | 🟠 ปานกลาง | S | B1-1 |
| P7 | `runJob` สาขา delivery ส่งคีย์ผิดให้ `finish_job` | 🟠 ปานกลาง | S | B2-2 |
| P8 | เลข migration ซ้ำ (022/023/024) + ฟังก์ชันถูกทับข้ามไฟล์ | 🟠 ปานกลาง | M | B4-7 |
| P9 | 2 unit test ไม่ถูกเรียกใน `npm test` | 🟠 ปานกลาง | S | B4-3 |
| P10 | ไม่มีเทสต์ replay/idempotency | 🟠 ปานกลาง | S | B2-3 |
| P11 | `claim_inbound` หยิบทีละ 1 แถว → เพดาน ~20 webhook/นาที | 🟠 ปานกลาง | S | B1-2 |
| P12 | ไม่มี secret scanner อัตโนมัติ | 🟠 ปานกลาง | S | B3-1 |
| P13 | `imports/` ไม่อยู่ใน `.gitignore` | 🟠 ปานกลาง | S | B3-2 |
| P14 | `ANSWER_HUB_*` ปิดทั้ง local และ prod — โค้ดไม่เคยรันจริง | 🟠 ปานกลาง | L | B5-3 |
| P15 | Smoke test แบบล็อกอินจริงค้างทุก deploy (403) | 🟠 ปานกลาง | M | B5-7 |
| P16 | `health/health.mjs` (307 บรรทัด) ไม่มี test เลย | 🟠 ปานกลาง | M | B4-4 |
| P17 | ของลับบนดิสก์กระจาย 10+ ไฟล์ ไม่รู้ว่าอันไหนยังใช้ได้ | 🟠 ปานกลาง | S | B3-3 |
| P18 | Telegram alert ของ health ไม่มี retry | 🟡 ต่ำ | S | B1-3 |
| P19 | ตัวแปรตายใน `.env` (`OPENROUTER_*`, `TELEGRAM_NOTIFY_ALL`) | 🟡 ต่ำ | S | B5-2 |
| P20 | `deploy-sha-local.txt` + `.tar.gz` ค้าง ชี้ commit เก่ากว่า prod | 🟡 ต่ำ | S | B5-8 |
| P21 | IP ของ VPS อยู่ในเอกสารที่ track แล้ว | 🟡 ต่ำ | S | B3-4 |

---

# 🔴 ระดับสูง

## P1 — `uncertain` delivery ไม่มีที่ให้ดู → แชทเงียบถาวร

**นี่คือปัญหาที่หนักที่สุดที่เจอในการตรวจรอบนี้**

**อาการ** ข้อความหาลูกค้าหนึ่งข้อความค้างสถานะ `uncertain` แล้วไม่มีสัญญาณใด ๆ
และเพราะมี ordering guard อยู่ ข้อความถัดไปทั้งหมดใน conversation เดียวกันจะไม่ถูกส่งตามไปด้วย
→ ลูกค้ารายนั้นเงียบถาวร จนกว่าจะมีคนบังเอิญไปดูตารางในฐาน

**หลักฐาน**

| จุด | ไฟล์:บรรทัด | สิ่งที่เห็น |
|---|---|---|
| สถานะถูกเขียนลงไป | `sql/003_job_worker.sql:433` | `status = case when ... 'uncertain' ...` |
| Messenger ยิงซ้ำไม่ได้ | `providers.mjs:298, 301-303` | Meta ไม่มี idempotency key → `outcome()` คืน `uncertain` ที่ 5xx |
| crash ก็กลายเป็น uncertain | `sql/003_job_worker.sql:407-408` | lease หมดอายุ 2 นาที + channel ≠ line |
| **ordering guard นับเป็นของค้าง** | `sql/003_job_worker.sql:415` | `older.status in ('pending','processing','uncertain')` |
| **ไม่มีใครอ่านกลับ** | — | ค้นทั้ง `public/*.js` และ RPC `health_queue` แล้ว **ไม่มีที่ไหนแสดงจำนวน `uncertain`** |

**ทำไมเกิด** การออกแบบถูกต้องทุกอย่าง — "ไม่รู้ว่าถึงหรือไม่ถึง จึงไม่ยิงซ้ำ ให้คนตัดสิน"
แต่ทำครึ่งเดียว: สร้างสถานะแล้วไม่ได้สร้างที่ให้คนตัดสิน ระบบ "ให้คนดู" ที่ไม่มีคนเห็น

**วิธีแก้**
1. เพิ่ม `count(*) filter (where status='uncertain')` เข้า RPC `health_queue`
2. แสดงเป็นแถวบน `/admin/health` พร้อมลิงก์ไปที่ conversation
3. ปุ่มสองปุ่ม: "ยืนยันว่าส่งแล้ว" (→ `sent`) / "ส่งซ้ำ" (→ `pending`)
4. เพิ่มกฎใน `inbox.monitor_rule` ให้ยิง Telegram เมื่อมี `uncertain` ค้างเกิน N นาที

**Effort: M**

---

## P2 — `.env.example` ขาด 10 ตัวแปรที่โค้ดใช้จริง

**อาการ** ตั้งเครื่องใหม่จาก `.env.example` แล้วได้ระบบที่ **บูตขึ้นปกติ แต่ไม่ทำอะไรเลย**
ไม่มี error ไม่มี warning `/health` ตอบ `ok: true` ด้วยซ้ำ

**หลักฐาน** เทียบ `process.env.*` ทั้งหมดในโค้ด กับ `.env.example` แล้วขาด:

| ตัวแปร | ใช้ที่ | ผลถ้าไม่มี |
|---|---|---|
| **`CONNECT_CHANNELS_FILE`** | `server.mjs:48` | **ไม่มี = `channels = []` → `activeChannels = []` → worker ทั้งสองตัว `return` ทันที** (`server.mjs:437, 886`) — ระบบเงียบสนิท |
| `ANSWER_HUB_ENABLED` | `server.mjs:539` · `service.mjs:65` | คลังคำตอบปิด |
| `ANSWER_HUB_BOT_ENABLED` | `server.mjs:540` | บอทไม่ใช้คลังคำตอบ |
| `ANSWER_HUB_LEARNING_ENABLED` | `server.mjs:503` | ไม่เก็บ learning candidate |
| `ANSWER_HUB_DYNAMIC_DATA_ENABLED` | `service.mjs:66` | — |
| `ANSWER_HUB_IMPORT_ENABLED` | `service.mjs:69` | — |
| `TEST_USER_IDS` | `bots/testcmd.mjs:12` | คำสั่ง `test` ของทีมใช้ไม่ได้ |
| `APP_VERSION` | `server.mjs:959` | `/health` รายงาน `version: null` — ไล่ไม่ได้ว่า prod รันอะไร |
| `SESSION_DIR` | `server.mjs:205` | — |
| `PUBLIC_URL` / `CONNECT_WORKER_STALE_MS` | `server.mjs:247, 56` | — |

**ทำไมเกิด** `.env.example:1` เขียนเจตนาไว้ถูก ("ไฟล์นี้เข้า git ได้ ห้ามมีค่าจริง")
แต่ไฟล์ไม่ได้ทำหน้าที่หลักอีกข้อคือ "เป็นรายการตัวแปรที่ครบ" — ตัวแปรใหม่ถูกเพิ่มในโค้ดโดยไม่ได้ย้อนมาเติมที่นี่

**วิธีแก้** เติมให้ครบ + แบ่งหัวข้อเป็น **บังคับ / ตัวเลือก** ให้ชัด
ทางที่ยั่งยืนกว่า: เพิ่ม check ใน `npm run check` ที่ grep `process.env.` แล้วเทียบกับ `.env.example`

**Effort: S**

---

## P3 — `docs/deploy.md:19` รายการ `COPY` ไม่ตรง `Dockerfile` จริง

**อาการ** เอกสาร deploy ผิดในทางที่ทำให้ **container บูตไม่ขึ้น**

**หลักฐาน**

```
docs/deploy.md:19  →  package.json server.mjs providers.mjs auth.mjs bots/ reports/ public/ lib/ scripts/
Dockerfile:3-18    →  ...ทั้งหมดข้างบน + health/ + services/
```

`Dockerfile:13-14` และ `:16-17` เขียนเตือนไว้เองว่า:
> "ถ้าลืมบรรทัดนี้ container จะขึ้นไม่ได้เลย เพราะ import หาไฟล์ไม่เจอตั้งแต่ตอนบูต"

**ทำไมเกิด** เคยเกิดมาแล้วจริง — `docs/handoff/2026-09-18-admin-health-ui-integration.md`
บันทึกไว้ว่า deploy รอบเช้าล้มด้วย `ERR_MODULE_NOT_FOUND: /app/services/answer-hub/service.mjs`
แล้วต้อง rollback → มีคนแก้ `Dockerfile` แต่ไม่ได้ย้อนมาแก้ `docs/deploy.md`

**วิธีแก้** แก้บรรทัดเดียว หรือดีกว่า: เปลี่ยน doc ให้ชี้ไปที่ `Dockerfile` แทนการคัดลอกรายการมา
(รายการที่คัดลอกมาจะค้างอีกแน่นอน)

**Effort: S**

---

## P4 — ไม่มี CI เลย

**อาการ** ไม่มี `.github/`, `.gitlab-ci.yml`, ไม่มีอะไรทั้งนั้น (ตรวจแล้ว)
ทุกอย่างพึ่ง "คนรัน `npm test` ก่อน deploy" ซึ่ง `docs/deploy.md` **ไม่ได้บังคับเป็นขั้นตอนด้วยซ้ำ**
— ขั้นตอนที่ 2 ข้ามจาก commit ไป `git archive` ตรง ๆ

**หลักฐาน** `docs/deploy.md:38-50` — ไม่มีขั้นตอนรันเทสต์

**สิ่งที่ทำให้ยาก** ชุดใหญ่ที่สุด (`tests/http.integration.mjs` 101 KB) เขียนลงฐานจริงผ่าน docker container
ตามที่ระบุเองที่ `tests/http.integration.mjs:14-15` → รันบนเครื่องที่ไม่มี Supabase stack ไม่ได้

**วิธีแก้ (เป็นขั้น)**
1. **ทันที (S)** CI ที่รันแค่ `npm run check` + unit tests ที่ไม่ต้องใช้ DB — ได้ประโยชน์ 80% ด้วยแรง 10%
2. **ถัดไป (M)** แยก `package.json` เป็น `test:unit` (ไม่ต้องใช้ DB) กับ `test:db`
3. **ยั่งยืน (M)** เพิ่มขั้นตอน "รัน `npm test` และแนบผล" เป็นขั้นบังคับใน `docs/deploy.md`

**Effort: S → M**

---

## P5 — เอกสารสถานะ deploy ขัดกันเอง + `master` ตามหลัง 40 commit

**อาการ** ตอนเกิดเหตุจริงตีสาม **ไม่มีเอกสารไหนที่เชื่อถือได้ว่าตอนนี้ production เป็นอะไร**

**หลักฐาน — ความขัดแย้งที่เจอ**

| แหล่ง | บอกว่า |
|---|---|
| `docs/answer-hub/PHASE-STATUS.md` (ตาราง) | Phase 13–17 = **NOT STARTED** |
| `docs/answer-hub/PHASE-STATUS.md` (หัวข้อ MVP override ไฟล์เดียวกัน) | Phase 13–25 = **MVP READY** |
| ของจริงในรีโป | migration ครบ: `202609181300_quick_answer.sql`, `..1400_recommendation.sql`, `..1600_usage.sql`, `..1700_feedback.sql` + RPC อยู่ใน `AH_ACTIONS` (`server.mjs:222`) |
| `docs/answer-hub/HARDENING-TODO.md` | "Keep production on `97d1b636…`" |
| `docs/answer-hub/HANDOFF.md` | deploy ไปแล้ว `6895b20` → `b530337` → `6743b45` |
| `deploy-sha-local.txt` (ในโฟลเดอร์) | ชี้ `97d1b636…` |

**เรื่อง branch** `fix/worker-resync-test-reset` นำหน้า `master` **40 commit** และ `master` ไม่มีอะไรที่ branch นี้ไม่มี
ของที่รันบน production มาจาก branch นี้ ไม่ใช่จาก `master`
→ `master` ไม่ได้สะท้อนอะไรเลย ใครเผลอ deploy จาก `master` = ย้อนกลับไปหลายสัปดาห์

**วิธีแก้**
1. เลือกแหล่งความจริงแหล่งเดียว — แนะนำ `.deployed-commit` บน VPS + ตารางเดียวใน `HANDOFF.md`
2. ลบ/ปรับตาราง Phase ใน `PHASE-STATUS.md` ที่ขัดกับ override ในไฟล์เดียวกัน
3. merge branch เข้า `master` (หรือเปลี่ยน default branch ให้ตรงความจริง)
4. ลบ `deploy-sha-local.txt` + `deploy-*.tar.gz` ที่ค้าง (ดู P20)

**Effort: M**

---

# 🟠 ระดับปานกลาง

## P6 — ไม่มี alert ตอน `webhook_log` ตกเป็น `failed`

หลัง retry 5 ครั้ง แถวเปลี่ยนเป็น `failed` (`sql/003_job_worker.sql:389`) แล้วเงียบ
ตรวจ `sql/202609172025_health.sql` + `sql/202609181800_health.sql` แล้วไม่มีกฎไหนนับสถานะนี้
→ ข้อความลูกค้าที่แปลงไม่สำเร็จหายเงียบ **Effort: S**

## P7 — `runJob` สาขา delivery ส่งคีย์ผิดให้ `finish_job`

`server.mjs:489-494` catch แล้วเรียก `finishJob(job, …)` ซึ่งส่ง `job_id: job.id` (`server.mjs:497-498`)
แต่งาน delivery มาจาก RPC `claim` ที่คืนแถวของ `connect_private.delivery` ซึ่งคีย์คือ `message_id` **ไม่มี `id`** (`sql/003_job_worker.sql:413-421`)
→ ถ้า RPC `finish` (`server.mjs:482`) ล้มเพราะเน็ตสะดุด งานปิดไม่ลง แถวค้าง `processing` → reclaim 2 นาที → Messenger กลายเป็น `uncertain` **ทั้งที่ส่งถึงลูกค้าไปแล้วจริง**
ไม่ทำให้ข้อความซ้ำ (ปลอดภัยด้าน correctness) แต่ขยายโอกาสเกิด P1 **Effort: S**

## P8 — เลข migration ซ้ำ + ฟังก์ชันถูกทับข้ามไฟล์

ผล `npm run check` วันนี้:
```
เตือน: เลข 022 ซ้ำ (022_send_mode_switch.sql , 022_contact_profile_sync.sql)
เตือน: เลข 023 ซ้ำ (023_sla_case_status.sql , 023_channel_health.sql)
เตือน: เลข 024 ซ้ำ (024_case_status_api.sql , 024_queue_counts.sql)
```
พร้อมรายการฟังก์ชันที่ถูกทับ: `inbox.ah_save`, `ah_retire`, `ah_versions`, `ah_resolve`, `answer_hub._snapshot_version`
→ ลำดับ apply ที่ต่างกันได้ definition คนละตัว **โดยยังผ่าน check**
นี่คือประเภทปัญหาที่ทำให้ "local ผ่าน prod พัง" ซึ่งเกิดกับโปรเจกต์นี้มาแล้ว (`HANDOFF.md` เรื่อง `202609180530_source_registry.sql`)
**Effort: M** — ต้องระวังทะเบียน `inbox.sql_applied` บน production

## P9 — 2 unit test ไม่ถูกเรียกใน `npm test`

`package.json:11` ไม่มี `tests/sla.test.mjs` และ `tests/notify-test-prefix.test.mjs` (149 บรรทัด)
ทั้งคู่เป็น unit test แท้ ๆ ไม่ต้องใช้ DB — เขียนไว้แล้วแต่ไม่มีใครรัน = ความมั่นใจปลอม
(อีก 2 ไฟล์ `*.browser.mjs` ต้องมีเบราว์เซอร์ พอเข้าใจได้) **Effort: S**

## P10 — ไม่มีเทสต์ replay/idempotency

ด่านกันซ้ำคือหัวใจของระบบ แต่ค้นใน `tests/http.integration.mjs` แล้วไม่มีเคสยิง payload เดิมสองครั้งแล้ว assert ว่าไม่เกิดข้อความซ้ำ
→ วันที่มีคนแก้ `receive` แล้วเผลอทำ dedupe พัง จะไม่มีอะไรจับได้ **Effort: S**

## P11 — `claim_inbound` หยิบทีละ 1 แถว

`sql/003_job_worker.sql:367-370` — `limit 1` ที่ 3 วินาที/รอบ = เพดานทฤษฎี ~20 webhook/นาที ต่อ container
ถ้ายิงแอดแล้วลูกค้าทักพร้อมกัน คิวจะยาวขึ้นเรื่อย ๆ โดย `/health` ยังเขียว (เพราะ `inboundLastSuccess` ขยับทุกรอบ)
เทียบกับขาออกที่ทำ batch 20 ไว้แล้ว (`server.mjs:443-449`) **Effort: S** — ระวัง lease + advisory lock ที่ `sql/036:99`

## P12 — ไม่มี secret scanner อัตโนมัติ

ตอนนี้ git สะอาดจริง แต่กันไว้ด้วย `.gitignore` + วินัยคนอย่างเดียว
`docs/answer-hub/HARDENING-TODO.md` ยอมรับเองว่า "Phase 19 automated secret scanner remain hardening items"
**Effort: S** — แต่ต้องมี CI ก่อน (P4)

## P13 — `imports/` ไม่อยู่ใน `.gitignore`

`imports/asher-facebook-quick-replies-filled-naii.xlsx` untracked และ **ไม่ถูก ignore** → `git add -A` ครั้งเดียวเข้า repo
ไม่ใช่ credential แต่เป็นข้อมูลธุรกิจ (ราคา/สคริปต์ขายโครงการ Naii) และ `HANDOFF.md` ระบุว่าต้องกันไม่ให้เข้า deploy archive
เข้าไปแล้วลบยาก (ต้อง rewrite history) **Effort: S — 1 บรรทัด**

## P14 — `ANSWER_HUB_*` ปิดทั้ง local และ prod

ตรวจ `.env` ของ local แล้วไม่มี `ANSWER_HUB_*` เลย และ `HANDOFF.md` ยืนยันว่า prod ก็ unset
→ Answer Hub ที่พัฒนามา 12 phase **ไม่เคยถูกเดินจริงในสภาพแวดล้อมไหนเลย**
โดยเฉพาะ `server.mjs:539-551` (บอทหยิบคำตอบจาก Hub ก่อน fallback ไป Claude) ซึ่งอยู่บนเส้นทางที่ตอบลูกค้าจริง
**Effort: L** — ต้องเปิดแบบ staged พร้อม rollback ไม่ใช่สลับ flag เฉย ๆ

## P15 — Smoke test แบบล็อกอินจริงค้างทุก deploy

`HANDOFF.md` และ `QUICK-REPLY-IMPORT-DEPLOYMENT.md` บันทึกซ้ำ ๆ ว่า
"authenticated UI/API smoke could not be completed — production login returned HTTP 403"
→ ทุก deploy ที่ผ่านมายืนยันได้แค่ `/healthz` 200 **ไม่มีใครเคยยืนยันว่าคนล็อกอินเข้าใช้งานได้จริงหลัง deploy**
deploy ที่ทำให้ล็อกอินพังจะไม่ถูกจับ **Effort: M** — ต้องมีบัญชี smoke ที่ใช้ได้จริงก่อน

## P16 — `health/health.mjs` ไม่มี test เลย

307 บรรทัด และเป็นระบบเตือนภัยของทั้งระบบ — ถ้าตัวนี้พังเงียบ จะไม่มีใครรู้ว่าอะไรพังอีกเลย
โมดูลอื่นที่ไม่มี test: `sync-channels.mjs` (10 KB), `scripts/*` ทั้งโฟลเดอร์ **Effort: M**

## P17 — ของลับบนดิสก์กระจาย 10+ ไฟล์

`.env`, `.env.local`, `.env.bak-beforeTunnel`, `.env.bak-preNotify`, `channels.json`,
`channels.json.bak-prerename`, `channels.json.bak4`, `channels_ba22.json`, `channels_test.json`,
`.secrets-archive/` (5 ไฟล์)
ทั้งหมด ignored ถูกต้อง ✅ แต่ = สำเนา page access token / service_role key นอน plaintext อยู่ 10+ ที่ในโฟลเดอร์เดียว
**ไม่มีใครรู้ว่าอันไหนยังใช้ได้อยู่** → เครื่อง dev หลุด = token เพจจริงหลุดทั้งชุด
**Effort: S** — ย้ายของเลิกใช้ออกนอกโฟลเดอร์ repo แล้วหมุน token ที่ไม่แน่ใจ

---

# 🟡 ระดับต่ำ

| ID | ปัญหา | หลักฐาน | แก้ |
|---|---|---|---|
| **P18** | Telegram alert ของ health ยิงครั้งเดียว ล้มแล้ว log ทิ้ง — วันที่ Telegram ล่มพร้อมระบบ = ไม่มีใครรู้ | `health/health.mjs:134-147` | เพิ่ม retry 2–3 ครั้ง |
| **P19** | `.env` มี `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `TELEGRAM_NOTIFY_ALL` ซึ่ง **ไม่มีที่ไหนในโค้ดอ่านเลย** | ค้นทั้งรีโปแล้ว 0 hit | ลบ + หมุน `OPENROUTER_API_KEY` ทิ้ง |
| **P20** | `deploy-sha-local.txt` + `deploy-97d1b63….tar.gz` ค้างอยู่ ชี้ commit ที่เก่ากว่า prod มาก | โฟลเดอร์ root | ลบ (ignored อยู่แล้ว แต่หลอกตา) |
| **P21** | IP ของ VPS `187.53.139.175` อยู่ในไฟล์ที่ track แล้ว | `docs/deploy.md:29,55,56,80,90,100` | ย้ายไปเป็นตัวแปร/ไฟล์นอก git |

---

# ✅ สิ่งที่ตรวจแล้ว "ไม่มีปัญหา" — อย่าเสียเวลาตรวจซ้ำ

บันทึกไว้เพื่อให้คนถัดไปข้ามได้ และเพื่อไม่ให้ใครเผลอรื้อของที่ทำถูกแล้ว

| ด้าน | ผล | หลักฐาน |
|---|---|---|
| **Secret ใน git** | **สะอาด** — สแกนทุก commit ทุก branch แล้วเจอแต่ placeholder ในเอกสาร | `git log --all -p` + 7 pattern |
| **Idempotency ขาเข้า** | **แน่นมาก** — unique key ที่ฐาน + `on conflict do nothing` + advisory lock + กันซ้ำชั้นสองสำหรับ echo | `sql/001:22` · `sql/036:73-78, 99, 143-205` |
| **event_id มาจาก provider** | ✅ ไม่ได้ปั้นเอง และกรณีที่ provider ไม่ให้ ก็ปั้นแบบ deterministic | `providers.mjs:96, 186, 201, 210, 218` |
| **Signature verification** | ✅ timing-safe + เช็ค length ก่อน | `providers.mjs:14-20` |
| **ตรวจปลายทางก่อนเก็บ** | ✅ ของที่ส่งผิดบ้านไม่เข้าบันทึกดิบ | `providers.mjs:29-33` |
| **Retry / backoff / lease** | ✅ ครบทั้งสามคิว (job, webhook_log, delivery) | `sql/003:85, 119-123, 389-391, 407-408, 433-434` |
| **Crash recovery** | ✅ lease หมดอายุ 2 นาที → ดีดกลับคิว | `sql/003:364-365, 407` |
| **LINE outbound idempotent** | ✅ `X-Line-Retry-Key` + จัดการ 409 เป็น `sent` | `providers.mjs:373-376, 380-382` |
| **Session security** | ✅ cookie เก็บแค่ opaque id · refresh token ไม่เคยผ่านเบราว์เซอร์ · ชื่อไฟล์เป็น sha256 · atomic write · single-flight refresh | `auth.mjs:7-19, 60-65, 86-102` |
| **Rate limit ล็อกอิน** | ✅ ถังรายอีเมล + ราย IP + cap ขนาด Map | `auth.mjs:121-136` |
| **CSRF** | ✅ `checkOrigin` บังคับทุกทางที่เปลี่ยนข้อมูล รวม login/logout | `server.mjs:1118-1121, 1475` |
| **ด่านสิทธิ์อยู่ใน SQL** | ✅ Node กันแค่เรียกฟังก์ชันนอกทะเบียน · คำสั่งวิ่งด้วย token คนล็อกอิน ไม่ใช่ service key | `server.mjs:211, 216, 222, 1264` |
| **Path traversal** | ✅ ตารางชื่อไฟล์ตายตัว ไม่ประกอบ path จาก input | `server.mjs:1388-1395, 1400-1402` |
| **Security headers + CSP** | ✅ ครบ | `server.mjs:1490-1493` |
| **Token ไม่หลุดถึงเบราว์เซอร์** | ✅ รวมถึง self-test ที่รายงานแค่ configured/missing | `server.mjs:269, 1060, 1087-1092` |
| **Log ไม่มี payload ลูกค้า** | ✅ ตรวจแล้วโค้ดทำตามกติกาที่ประกาศไว้ | `server.mjs:90, 771` |
| **ไม่มี catch ที่ทิ้ง error** | ✅ ตรวจทุก catch ในไฟล์หลักแล้ว รับตัว error และ log ครบ | `server.mjs:10` (กติกา) |
| **Timer จัดการถูกต้อง** | ✅ `.unref()` ทุกตัว + clear ครบใน SIGTERM | `server.mjs:1511-1535, 1539-1548` |
| **Image ไม่พา secret** | ✅ `COPY` เป็นรายชื่อไฟล์ ไม่มี `COPY . .` | `Dockerfile:3-18` |
| **Session รอด deploy** | ✅ named volume | `docker-compose.yml:16` |
| **Deploy จาก commit** | ✅ `git archive` ไม่ใช่ working tree | `docs/deploy.md:3, 38-50` |
| **Memory guard** | ✅ heap cap ต่ำกว่า container cap หนึ่งช่วง + เตือนที่ 140 MB | `Dockerfile:29` · `docker-compose.yml:25` · `server.mjs:914-923` |

**สิ่งที่ทำได้ดีเป็นพิเศษ (ห้ามรื้อ)**

1. **โหมดเงากันด้วยโครงสร้าง ไม่ใช่ `if`** — `server.mjs:462-463` ไม่ขอ job ชนิด `send` มาตั้งแต่แรก
   → `attempts` ไม่ขยับ ลำดับไม่เสีย เปิดโหมดกลับแล้วของค้างถูกส่งตามลำดับเดิมครบ
2. **`refreshSendMode` ล้มแล้วคงโหมดเดิม ไม่ fallback** — `server.mjs:420-433`
   เหตุผลเขียนไว้ชัด: fallback ไป "ส่งจริง" = ข้อความหลุดหาลูกค้าตอนฐานสะดุด
3. **`/health` ยอมตอบ 503 จริง** — `server.mjs:1437` ไม่ใช่แค่บอกว่าพอร์ตเปิด
4. **แยก AUTH/DATA layer ตอนแปล error** — `server.mjs:121-168` แก้ปัญหา "เซสชันหมดอายุถูกแปลงเป็น บันทึกไม่สำเร็จ"
5. **ช่องทางที่ปิดโดยตั้งใจตอบ 200 ไม่ใช่ 503** — `server.mjs:1136-1141` กัน Meta/LINE ถอด endpoint ทิ้งเอง
6. **คอมเมนต์อธิบาย "ทำไม" ไม่ใช่ "อะไร"** และเกือบทุกจุดอ้างเหตุการณ์จริงที่เคยพัง — นี่คือทรัพย์สินของโปรเจกต์นี้

---

# แผนลงมือ เรียงตามผลตอบแทนต่อแรง

## รอบที่ 1 — วันเดียวจบ (ทั้งหมด S)

| ลำดับ | งาน | ID |
|---|---|---|
| 1 | เติม `.env.example` ให้ครบ 10 ตัว โดยเฉพาะ `CONNECT_CHANNELS_FILE` | P2 |
| 2 | แก้ `docs/deploy.md:19` ให้ตรง `Dockerfile` | P3 |
| 3 | เพิ่ม `imports/` ใน `.gitignore` | P13 |
| 4 | เพิ่ม `sla.test.mjs` + `notify-test-prefix.test.mjs` เข้า `npm test` | P9 |
| 5 | ลบ `deploy-sha-local.txt` + `.tar.gz` ค้าง · ลบตัวแปรตายใน `.env` | P20, P19 |
| 6 | CI ขั้นต่ำ: `npm run check` + unit tests ที่ไม่ต้องใช้ DB | P4 |
| 7 | Alert เมื่อ `webhook_log` → `failed` | P6 |
| 8 | แก้คีย์ `finish_job` ของสาขา delivery | P7 |
| 9 | เทสต์ replay webhook ก้อนเดิมสองครั้ง | P10 |

## รอบที่ 2 — สัปดาห์ถัดไป (M)

| ลำดับ | งาน | ID |
|---|---|---|
| 10 | **ทำให้ `uncertain` มองเห็นได้บน `/admin/health` + ปุ่มตัดสิน** | P1 |
| 11 | รวมเอกสารสถานะ deploy เหลือแหล่งเดียว + merge `master` | P5 |
| 12 | แยก `npm test` เป็น `test:unit` / `test:db` | P4 |
| 13 | บัญชี smoke ที่ล็อกอินได้จริง + เพิ่มเป็นขั้นบังคับใน `docs/deploy.md` | P15 |
| 14 | test ให้ `health/health.mjs` | P16 |
| 15 | จัดระเบียบ migration ที่เลขซ้ำ | P8 |

## รอบที่ 3 — ต้องวางแผน (L)

| ลำดับ | งาน | ID |
|---|---|---|
| 16 | เปิด `ANSWER_HUB_*` แบบ staged พร้อม rollback | P14 |

---

**หมายเหตุ:** รายงานนี้ยังไม่ครอบ requirement 10 ข้อที่ผู้ใช้ตั้งใจจะวางมา
(prompt ค้างเป็น placeholder `[วาง requirement 10 ข้อ]`) — ดู `GAP_ANALYSIS.md` ส่วน A
