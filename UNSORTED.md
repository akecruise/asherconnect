# UNSORTED — ไฟล์ที่ยังไม่รู้ว่าควรอยู่ตรงไหน (16 ก.ย. 2026)

branch `wip/unsorted-20260916` แตกจาก HEAD ของ `fix/worker-resync-test-reset`

**เหตุผลที่มี branch นี้:** ไฟล์ทั้งหมดข้างล่างอยู่ในเวิร์กทรีมานาน บางไฟล์เป็นงานที่ทำค้างไว้
บางไฟล์เป็นเครื่องมือใช้ครั้งเดียว ถ้าปล่อยไว้เฉย ๆ จะหายตอนสลับ branch
จึงเก็บไว้ที่นี่ก่อน **ไม่ได้แปลว่าพร้อมใช้ และไม่มีไฟล์ไหนถูก deploy**

★ ไม่มีไฟล์ไหนในนี้อยู่ใน `Dockerfile COPY` ยกเว้น `lib/claude.mjs` และ
  `reports/send-daily-report.mjs` ซึ่งอยู่ในโฟลเดอร์ที่ถูก COPY — **ตรวจก่อน deploy ทุกครั้ง**

---

## ไฟล์ที่แก้จากของเดิม (tracked)

| ไฟล์ | mtime | ดูเหมือนงานอะไร |
|---|---|---|
| `.env.example` | 15 ก.ย. 14:42 | **ล็อกอินรายบุคคล** — ลบ `CONNECT_ACCOUNT_EMAIL/PASSWORD` (ยุคที่ไม่มีชั้นล็อกอิน) เพิ่มคำอธิบาย `SESSION_DIR` |
| `sync-channels.mjs` | 15 ก.ย. 14:05 | **ความถูกต้องของคอนฟิก** — เลิกไล่หาไฟล์ secrets สามที่ ใช้ `Asher_ERP-secrets.php` อย่างเดียว (mkt18 เลิกใช้แล้วแต่ชนะลำดับเสมอ ทั้งที่ค่าเก่ากว่าหนึ่งสัปดาห์) และเลิกเปิด `line.enabled` กลับเองเมื่อคนตั้งใจปิดไว้ |
| `tests/http.integration.mjs` | 15 ก.ย. 12:25 | **เทสต์ล็อกอินรายบุคคล** — เปลี่ยนจากยิง `/api/command` ตรง ๆ เป็นล็อกอินก่อนแล้วถือคุกกี้ ตรวจรูปแบบคุกกี้และ `HttpOnly` |

สามไฟล์นี้น่าจะเป็นชุดเดียวกับ `auth.mjs` + `public/login.css` ที่ commit ไปแล้วบน `fix`
**ถ้ายืนยันได้ว่าใช่ ควรย้ายไป `fix` แล้วรวมเป็นก้อน "ล็อกอินรายบุคคล"**

---

## ไฟล์ใหม่ (untracked)

### เอกสาร / แผน

| ไฟล์ | mtime | บรรทัด | ดูเหมือนงานอะไร |
|---|---|---|---|
| `ROADMAP.md` | 16 ก.ย. 08:32 | 235 | แผนภาพรวมของ asher-connect |
| `CONFIG.md` | 16 ก.ย. 08:32 | 257 | คู่มือค่าคอนฟิกทุกตัว ว่าอยู่ที่ไหนต้องใส่อะไร — **ค่าในไฟล์เป็น placeholder ทั้งหมด ตรวจแล้ว** (`sk-ant-api03-xxxxx`) |
| `PLAN-mobile.md` | 15 ก.ย. 15:53 | 191 | แผนทำ ASHER Connect บนมือถือ |
| `docs/individual-login.md` | 15 ก.ย. 05:58 | 73 | บันทึกการออกแบบล็อกอินรายบุคคล |
| `docs/stats-plan.md` | 15 ก.ย. 18:45 | 148 | แผนระบบสถิติการตอบ (คู่กับ `sql/016–019`, `027`, `028` ที่ยังไม่ลงฐาน) |

### โค้ดที่อาจเข้า image

| ไฟล์ | mtime | บรรทัด | ดูเหมือนงานอะไร | ⚠️ |
|---|---|---|---|---|
| `lib/claude.mjs` | 15 ก.ย. 14:42 | 65 | ตัวเรียก Claude API แบบบาง | **อยู่ใน `lib/` ซึ่ง Dockerfile COPY** |
| `reports/send-daily-report.mjs` | 15 ก.ย. 08:09 | 52 | ส่งรายงานประจำวัน | **อยู่ใน `reports/` ซึ่ง Dockerfile COPY** · อ่าน service key จาก env |

### เครื่องมือใช้มือ (ไม่เข้า image)

| ไฟล์ | mtime | บรรทัด | ดูเหมือนงานอะไร |
|---|---|---|---|
| `scripts/test-claude.mjs` | 15 ก.ย. 14:42 | 10 | ทดสอบว่า ANTHROPIC key ใช้ได้ |
| `set-meta-credentials.mjs` | 15 ก.ย. 13:45 | 100 | ตั้งค่า credential ของ Meta |
| `sync-contact-names.mjs` | 15 ก.ย. 10:42 | 111 | ดึงชื่อลูกค้ามาเติมใน `core.contact` |
| `test-webhook.mjs` | 14 ก.ย. 22:58 | 349 | ยิง webhook ปลอมเข้าเซิร์ฟเวอร์เพื่อทดสอบ |
| `tools/line-groupid-function.ts` | 16 ก.ย. 09:05 | — | Edge Function สำหรับหา LINE group id (ใช้ครั้งเดียวตอนกู้ `LINE_NOTIFY_GROUP_ID`) |

### ชุดทดสอบสถิติ

`tests/stats/` (8 ไฟล์ · mtime 15 ก.ย. 18:38) — ชุดตรวจของ `sql/016–019` และ `027`

```
00_stubs.sql        01_scenario.sql     03_outbox.sql     04_stats_v2.sql     run.mjs
00_stubs.sql.bak-preStatsV2   01_scenario.sql.bak-preStatsV2   run.mjs.bak-preStatsV2
```

⚠️ **มีไฟล์ `.bak-preStatsV2` ปนอยู่ 3 ไฟล์** — เป็นสำเนาก่อนแก้ ควรลบหรือย้ายออกก่อนรวมเข้า `fix`

---

## ที่ต้องทำต่อ

1. ยืนยันว่า `.env.example` · `sync-channels.mjs` · `tests/http.integration.mjs` ·
   `docs/individual-login.md` เป็นชุดเดียวกับล็อกอินรายบุคคลหรือไม่ → ถ้าใช่ย้ายไป `fix`
2. ตัดสินว่า `lib/claude.mjs` และ `reports/send-daily-report.mjs` พร้อมขึ้น image หรือยัง
   (สองไฟล์นี้อยู่ในโฟลเดอร์ที่ `Dockerfile` COPY — ถ้า merge เข้า `fix` แล้ว deploy จะขึ้นไปด้วย)
3. ลบไฟล์ `.bak-preStatsV2` ใน `tests/stats/`
4. เอกสาร 5 ไฟล์ควรอยู่ `docs/` ให้หมด (ตอนนี้ `ROADMAP.md` `CONFIG.md` `PLAN-mobile.md` อยู่ราก)

## ไม่ได้อยู่ใน branch นี้ (ถูก gitignore ไว้เพราะมีความลับจริง)

`channels_ba22.json` · `channels_test.json` — มี LINE channel secret, access token
และ Meta page token ของจริง **ห้าม commit เด็ดขาด** เพิ่ม `channels_*.json` ลง `.gitignore` แล้ว
