# HANDOFF — Gap analysis / audit ทั้งรีโป (อ่านอย่างเดียว · ไม่แก้โค้ด) (2026-09-19)

> **สถานะ: การตรวจเสร็จสมบูรณ์ · ไม่มีการแก้โค้ดหรือ config ใดเลย · ไม่มีอะไรต้อง rollback**
> **ค้าง 1 อย่าง:** requirement 10 ข้อที่ผู้ใช้ตั้งใจจะวางมายังไม่ถูกวาง — `GAP_ANALYSIS.md` ส่วน A จึงยังว่าง
> agent ถัดไปเริ่มที่หัว "ทางเดินต่อ" ท้ายไฟล์นี้ได้ทันที

---

## งานนี้ทำอะไร

ผู้ใช้สั่งให้อ่าน `PLAN.md`, `server.mjs`, migrations, UI และ scripts ทั้งรีโป
แล้วทำ gap analysis เทียบ requirement 10 ข้อ พร้อมตรวจเพิ่ม 5 หัวข้อ
(error handling/retry ของ webhook · idempotency ของ message · secrets ที่หลุดเข้า git ·
test coverage · ความต่างระหว่าง local กับ VPS) โดย **ห้ามแก้ไฟล์ใด ๆ**

ทำครบทุกอย่างยกเว้นส่วนที่ต้องใช้ requirement (ดูหัวข้อ "สิ่งที่ค้าง")

---

## ไฟล์ที่สร้าง (สร้างใหม่ทั้งหมด · ไม่ได้แก้ไฟล์เดิมแม้แต่ไฟล์เดียว)

| ไฟล์ | เนื้อหา | ใช้เมื่อไหร่ |
|---|---|---|
| `GAP_ANALYSIS.md` | รายงานตรวจฉบับเต็ม — หลักฐานรายบรรทัด (`ไฟล์:บรรทัด`), ชื่อ table/function, สถานะ done/partial/missing, ความเสี่ยง, effort S/M/L + ภาคผนวกแผนที่รีโป | อยากรู้ "ทำไมถึงสรุปแบบนั้น" หรือต้องการหลักฐานไปอ้างต่อ |
| `ISSUES.md` | รายงานสรุปปัญหา 21 ข้อ (P1–P21) เรียงตามความรุนแรง + ตาราง "ตรวจแล้วไม่มีปัญหา" + แผนลงมือ 3 รอบ | ใช้ทำงานจริง — เปิดไฟล์นี้ไฟล์เดียวพอ |
| `docs/handoff/2026-09-19-gap-analysis.md` | ไฟล์นี้ | ส่งต่อให้คนถัดไป |

**ยืนยัน:** `git status --porcelain` หลังจบงาน = `?? GAP_ANALYSIS.md` · `?? ISSUES.md` · `?? imports/`
(`imports/` เป็น untracked อยู่ก่อนเริ่มงานแล้ว ไม่ได้เกิดจากงานนี้)

---

## ขอบเขตที่ตรวจจริง

| ด้าน | ทำอะไร |
|---|---|
| โค้ด | `server.mjs` (1,548 บรรทัด — **อ่านทั้งไฟล์**) · `auth.mjs` · `providers.mjs` · `services/answer-hub/*` · `lib/*` · `bots/*` · `health/health.mjs` |
| SQL | `sql/` ทั้ง 58 ไฟล์ (สแกนทั้งหมด + อ่านเจาะจุด dedupe / retry / lease / ordering guard) · `migrations/20260914-shadow-replay.sql` |
| UI | `public/*.js` · `public/*.html` + เทียบกับตาราง `staticFiles` ที่ `server.mjs:1390-1395` ว่าเสิร์ฟอะไรจริงบ้าง |
| Scripts | `scripts/*` · `sql/run.mjs` · `sync-channels.mjs` · `verify-sql.mjs` |
| Git | สแกน **ทุก commit ทุก branch** ด้วย 7 secret pattern · เทียบ `HEAD` กับ `master` · ตรวจ `git status --ignored` |
| รันจริง | `npm run check` — **ผ่าน** (มี warning เรื่องเลข migration ซ้ำ ดู P8) |

### ที่ไม่ได้ทำ และเหตุผล

- **ไม่ได้รัน `npm test`** — `tests/http.integration.mjs:14-15` ระบุเองว่า "เขียนลงฐานจริง
  (ไม่มี transaction ให้ rollback เพราะคุยผ่าน HTTP)" และคุยกับ DB ผ่าน docker container
  ถือเป็นการแก้ state จึงข้ามตามข้อสั่ง "ห้ามแก้"
  → **ตัวเลข 312/312 ใน `ISSUES.md` มาจาก `docs/answer-hub/HANDOFF.md` ไม่ได้ยืนยันเองในรอบนี้**
- **ไม่ได้แตะ VPS** — ไม่ได้ ssh ไม่ได้อ่าน `.deployed-commit` จริง
  → สถานะ production ที่อ้างถึงมาจากเอกสารในรีโป ซึ่ง **ขัดกันเอง** (นั่นคือ P5)

---

## ผลตรวจโดยย่อ

### 5 หัวข้อที่ผู้ใช้สั่งให้ตรวจเพิ่ม

| หัวข้อ | สถานะ | ประเด็น |
|---|---|---|
| Webhook error handling / retry | **done** | แยกรับ/ประมวลผลถูกต้อง · backoff + lease + crash recovery ครบที่ฐาน · ขาดแค่ alert ตอน `failed` |
| Idempotency ของ message | ขาเข้า **done** / ขาออก **partial** | ขาเข้าแน่นมาก (unique key + advisory lock + กันซ้ำชั้นสอง) · LINE มี retry key · Messenger ใช้ `uncertain` แทน — **แต่ไม่มีใครเห็น `uncertain`** |
| Secrets ที่หลุดเข้า git | **ไม่พบการรั่ว** | ทุก commit ทุก branch สะอาด · เจอแต่ placeholder ในเอกสาร · `.gitignore` ครอบครบ |
| Test coverage | **partial** | ปริมาณเยอะ แต่ **ไม่มี CI เลย** · ชุดใหญ่สุดต้องมี DB จริง · 2 unit test ตกหล่น |
| ความต่าง local ↔ VPS | **partial** | โค้ดตรงกัน (prod `6743b45`, local HEAD เป็น doc-only) แต่ **config/doc drift หนัก** |

### ปัญหาที่ต้องรู้ 3 ข้อแรก

1. **P1 — `uncertain` delivery ไม่มีที่ให้ดู** (🔴 สูง · M)
   ระบบออกแบบว่า "ไม่รู้ว่าถึงหรือไม่ถึง จึงไม่ยิงซ้ำ ให้คนตัดสิน" — ถูกต้องทุกอย่าง
   แต่ **สร้างสถานะแล้วไม่ได้สร้างที่ให้คนตัดสิน** ค้นทั้ง UI และ `health_queue` แล้วไม่มีที่ไหนแสดงจำนวน `uncertain`
   และ ordering guard ที่ `sql/003_job_worker.sql:415` นับ `uncertain` เป็นของค้าง
   → **ลูกค้ารายนั้นเงียบถาวร ทั้ง conversation ไม่ใช่แค่ข้อความเดียว**

2. **P2 — `.env.example` ขาด 10 ตัวแปร** (🔴 สูง · S)
   สำคัญสุดคือ `CONNECT_CHANNELS_FILE` (`server.mjs:48`) — ไม่มี = `activeChannels` ว่าง
   = worker ทั้งสองตัว `return` ทันที (`server.mjs:437, 886`) **โดย `/health` ยังตอบ `ok: true`**
   ตั้งเครื่องใหม่จากไฟล์นี้จะได้ระบบที่บูตขึ้นแต่เงียบสนิท ไม่มีอะไรบอกว่าทำไม

3. **P3 — `docs/deploy.md:19` ผิด** (🔴 สูง · S)
   ระบุรายการ `COPY` ไม่ตรง `Dockerfile:3-18` จริง (ขาด `health/` และ `services/`)
   **เคยทำ production ล่มมาแล้ว** — ดู `docs/handoff/2026-09-18-admin-health-ui-integration.md`
   (`ERR_MODULE_NOT_FOUND: /app/services/answer-hub/service.mjs` → restart loop → rollback)
   doc ยังไม่ถูกแก้ตาม

ที่เหลือ P4–P21 อยู่ใน `ISSUES.md`

---

## สิ่งที่ค้าง (blocker เดียวของงานนี้)

**requirement 10 ข้อยังไม่ถูกวางมา**

prompt เดิมจบด้วย placeholder `[วาง requirement 10 ข้อ]` — ไม่มีเนื้อ requirement จริง
ผมไม่เดาเอง เพราะเดาผิดแล้วทั้งตารางจะไร้ค่า

`GAP_ANALYSIS.md` ส่วน A จึงเป็น **โครงตารางเปล่ารอเติม** (10 แถว พร้อมนิยามทุกคอลัมน์แล้ว)
ฐานหลักฐานสำหรับเติมเก็บครบแล้วในส่วน B และภาคผนวก — **ไม่ต้องสแกนรีโปใหม่**
วาง requirement มาแล้วเติมได้เลย

---

## ข้อค้นพบระหว่างทางที่ควรรู้

1. **ไม่มี `PLAN.md` ในรีโปนี้**
   ค้นทั้งรีโปแล้วเจอแค่ `.handoff/PLAN-stats-phase1-report.md` ซึ่งเป็นรายงาน Phase 1 ของหน้าสถิติ
   เอกสารที่ทำหน้าที่ "แผน/สถานะ" จริงคือ `docs/answer-hub/ROADMAP.md` + `PHASE-STATUS.md` +
   `FINAL-ACCEPTANCE-MATRIX.md` + `HANDOFF.md` + `README.md` — ผมใช้ชุดนี้แทน
   **ถ้ามี `PLAN.md` จริงอยู่นอกรีโป ต้องเอาเข้ามาหรือชี้ path ให้**

2. **`master` ตามหลัง 40 commit และไม่มีอะไรที่ branch ปัจจุบันไม่มี**
   ของที่รันบน production มาจาก `fix/worker-resync-test-reset` ไม่ใช่จาก `master`
   → ใครเผลอ deploy จาก `master` = ย้อนกลับไปหลายสัปดาห์ (P5)

3. **เอกสารสถานะ deploy ขัดกันเอง 3 ทาง** — `PHASE-STATUS.md` ตารางบอก Phase 13–17 NOT STARTED
   แต่ override ในไฟล์เดียวกันบอก MVP READY และ migration ก็มีครบจริง
   ส่วน `HARDENING-TODO.md` บอกให้คง prod ที่ `97d1b636` แต่ `HANDOFF.md` บอก deploy ไปถึง `6743b45` แล้ว (P5)

4. **บั๊กเล็กที่เจอจากการอ่านโค้ด** — `server.mjs:489-498` สาขา delivery ใน `runJob`
   ส่ง `job_id: job.id` ให้ RPC `finish_job` แต่งานจาก RPC `claim` มีคีย์เป็น `message_id` ไม่มี `id`
   (`sql/003_job_worker.sql:413-421`) → ไม่ทำข้อมูลเสีย แต่ขยายโอกาสเกิด P1 (P7)

5. **`npm run check` ผ่านแต่มี warning ที่ไม่ควรมองข้าม** — เลข migration ซ้ำ 022/023/024
   และฟังก์ชัน `ah_save`/`ah_retire`/`ah_versions`/`ah_resolve`/`_snapshot_version` ถูกทับข้ามไฟล์
   ลำดับ apply ที่ต่างกันได้ definition คนละตัว **โดยยังผ่าน check** (P8)

---

## สิ่งที่ห้ามรื้อ (ตรวจแล้วทำถูกและมีเหตุผลเขียนกำกับไว้)

1. **โหมดเงากันด้วยโครงสร้าง ไม่ใช่ `if`** — `server.mjs:462-463` ไม่ขอ job ชนิด `send` ตั้งแต่แรก
   → `attempts` ไม่ขยับ ลำดับไม่เสีย เปิดกลับแล้วของค้างส่งตามลำดับเดิมครบ
2. **`refreshSendMode` ล้มแล้วคงโหมดเดิม ไม่ fallback** — `server.mjs:420-433`
3. **ช่องทางที่ปิดโดยตั้งใจตอบ 200 ไม่ใช่ 503** — `server.mjs:1136-1141` กัน Meta/LINE ถอด endpoint ทิ้งเอง
4. **ด่านสิทธิ์อยู่ใน SQL ไม่ใช่ Node** — Node กันแค่เรียกฟังก์ชันนอกทะเบียน (`server.mjs:211, 216, 222`)
5. **`/health` ยอมตอบ 503 จริง** — `server.mjs:1437`
6. **Session: cookie เก็บแค่ opaque id · refresh token ไม่เคยผ่านเบราว์เซอร์** — `auth.mjs:7-19`

รายการเต็มพร้อมหลักฐานอยู่ในหัวข้อ "✅ สิ่งที่ตรวจแล้วไม่มีปัญหา" ของ `ISSUES.md`
— **ใช้ตารางนั้นเพื่อข้ามการตรวจซ้ำ**

---

## ทางเดินต่อ

### ถ้ามี requirement 10 ข้อแล้ว
วางลงมาแล้วเติม `GAP_ANALYSIS.md` ส่วน A — โครงตารางและฐานหลักฐานพร้อมแล้ว ไม่ต้องสแกนรีโปใหม่

### ถ้าจะลงมือแก้ปัญหา
เปิด `ISSUES.md` หัวข้อ "แผนลงมือ" — แบ่งเป็น 3 รอบแล้ว

**รอบที่ 1 (วันเดียวจบ ทั้งหมด S):** P2 → P3 → P13 → P9 → P20/P19 → P4(CI ขั้นต่ำ) → P6 → P7 → P10
**รอบที่ 2 (M):** P1 (สำคัญสุด) → P5 → P4(แยก test:unit/test:db) → P15 → P16 → P8
**รอบที่ 3 (L):** P14 (เปิด `ANSWER_HUB_*` แบบ staged)

### ข้อควรระวังก่อนแตะอะไร

- **ก่อนส่ง `server.mjs` ขึ้น VPS ต้องสแกน `import` ทั้งไฟล์** เทียบกับ `Dockerfile` COPY
  (บทเรียนจาก `docs/handoff/2026-09-18-admin-health-ui-integration.md` — เคยทำ prod ล่มมาแล้ว)
- **แตะ `sql/` ต้องระวังทะเบียน `inbox.sql_applied` บน production** — `HANDOFF.md` บันทึกไว้ว่า
  ทะเบียนเคยไม่ตรงกับ catalog จนต้องหยุด deploy
- **อย่าเพิ่งเปิด `ANSWER_HUB_*`** — โค้ด path `server.mjs:539-551` อยู่บนเส้นทางที่ตอบลูกค้าจริง
  และไม่เคยถูกเดินจริงในสภาพแวดล้อมไหนเลย
- **รัน `npm test` ต้องมี Supabase stack ขึ้นอยู่** และมันเขียนลงฐานจริง (ติดป้าย `__httptest__` แล้วลบตอนจบ)

---

## สรุปหนึ่งบรรทัด

โค้ดแกนแข็งแรงกว่าที่คาด — ปัญหาเกือบทั้งหมดคือ **"ของที่ออกแบบไว้แล้วแต่ไม่มีใครเห็น"**
(`uncertain` ที่ไม่มีหน้าจอ · ตัวแปรที่ไม่อยู่ใน `.env.example` · doc ที่ค้าง · เทสต์ที่ไม่มีใครรัน)
ไม่ใช่ตรรกะผิด — จึงแก้ได้เร็วและคุ้มมาก
