# Handoff — ตัวส่ง LINE หลายคน · Follow→Lead · SLA/escalate · LIFF นัดชม (Phase 0–4)

วันที่ 2026-10-02 · roadmap: `line-roadmap-phases.md`
ไฟล์นี้เป็น **สรุปรวมของทั้งเซสชัน** — รายละเอียดต่อ phase อยู่ในไฟล์ที่ลิงก์ไว้ท้ายเอกสาร

> ## ★★ ยังไม่ deploy อะไรเลย
> production ยังเป็น **`4a5482d`** เหมือนก่อนเริ่มเซสชัน · ไม่ได้รัน SQL บน VPS · ไม่ได้แตะ `.env` / `channels.json`
> ไม่ได้เปิด `LINE_BROADCAST_LIVE` · ไม่ได้เปิด `ASHER_CRM_PUBLISH_ENABLED` · **ไม่มีข้อความถึงลูกค้าจริงแม้แต่ข้อความเดียว**

## สถานะตอนส่งมอบ

| | |
|---|---|
| Production (VPS) | `4a5482d` — **ไม่เปลี่ยน** |
| branch งาน (Connect) | `feature/line-broadcast-sender` = **21 commit** เหนือ `hotfix/login-button-color` · **push ขึ้น GitHub แล้วครบ** |
| branch งาน (CRM) | worktree `D:\aplus_postgres_docker\asher-crm-follow-lead` branch `feature/sales-handoff` = **7 commit** เหนือ `release/sep25` · ★ **local เท่านั้น — repo `asher-crm` ไม่มี git remote จึง push ไม่ได้** |
| `hotfix/login-button-color` | **ไม่ได้แตะ** ตามที่สั่ง · ตรวจแล้ว branch งาน = สายนั้น + commit ของเราล้วน **ไม่มีโอกาส conflict** (merge เป็น fast-forward ได้) |
| SQL ที่ยังไม่เคยลงที่ไหน | Connect 5 ไฟล์ · CRM 3 ไฟล์ (ดูตารางข้างล่าง) |
| Phase | 0–4 เสร็จ · **5 ไม่ทำ** เพราะ roadmap สั่งเองว่า "แยก prompt" + ต้องมีข้อมูลจริงจากการ deploy ก่อน |

★ บน branch Connect มี **2 commit ที่ไม่ใช่ของเซสชันนี้** — `1ac1e2d` (เปิด endpoint flags ให้ CRM) และ `646c247` (แก้ CHECK ของ outbox) มีอีก session ทำงานขนานกันบน branch เดียวกัน

---

## SQL ที่ต้องรันตอน deploy (ตามลำดับ)

| # | ไฟล์ | เพิ่มอะไร |
|---|---|---|
| 1 | `sql/202610021200_line_broadcast.sql` | ตารางงานส่ง broadcast + สถานะ follow ต่อช่องทาง + `inbox.crm_event_id` |
| 2 | `sql/202610030900_follow_welcome_flex.sql` | ข้อความต้อนรับ Flex (เก็บแบบไว้ใน `bot_config`) + ส่ง postback ต่อ |
| 3 | `sql/202610031100_service_outbound.sql` | ให้ CRM สั่งแจ้งทีม / ส่งหาลูกค้า / แปลงตัวตน→contact_ref |
| 4 | `sql/202610031200_crm_contact_flags_service.sql` | ★ **ของอีก session** (endpoint อ่าน/เขียน tag-ดาว ให้ CRM) |
| 5 | `sql/202610031400_liff_site_visit.sql` | รับคำขอนัดจากหน้า LIFF |

**ทั้งหมด additive รันซ้ำได้ ไม่แตะ `connect_private.api` / `receive_event` / `enqueue_outbound`** (สามตัวนี้บน VPS ใหม่กว่า repo)

ฝั่ง CRM: `sql/sandbox/020_inbound_keyword_rules.sql` · `021_business_hours_escalation.sql` · `022_liff_appointments.sql`

---

## ได้ฟีเจอร์อะไร

| | Connect | CRM |
|---|---|---|
| **ส่งหลายคน** | `/internal/broadcasts` + worker ยิง multicast · quota gate · dry-run | หน้าจอ campaign (ยังไม่ทำ — เป็น Phase ของ CRM spec ส่วน B) |
| **Follow→Lead** | ตอบ Flex 3 ปุ่มตอนเพิ่มเพื่อน (ใช้ reply token = **ฟรี**) · ส่ง postback ต่อ | เปิด lead · ติด tag โครงการจากปุ่ม · unfollow = activity เท่านั้น |
| **SLA / handoff** | `/internal/notify` · `/internal/contacts/:ref/messages` · `/internal/contacts/resolve` | คำสำคัญ→งานด่วน · เวลาทำการ · escalate · auto-reply นอกเวลา |
| **LIFF นัดชม** | หน้า `/liff` + ยืนยัน ID token กับ LINE | รับนัด · กันจองซ้ำ · เลือกเซลส์ที่ว่างจริง · เตือนล่วงหน้า 1 วัน |

### `/internal/*` ทั้งหมด (ด่าน = `CONNECT_SERVICE_TOKEN`, ไม่ใช่ login พนักงาน)
```
POST /internal/broadcasts · GET /internal/broadcasts/:id · POST .../cancel
GET  /internal/line/quota?channel_key=
GET  /internal/contacts/:ref/recent-messages · /profile
GET  /internal/media-library
POST /internal/contacts/resolve      ← แปลง (provider, account_scope, external_id) → contact_ref
POST /internal/notify                 ← แจ้งทีม (escalation ของ CRM)
POST /internal/contacts/:ref/messages ← ให้ Connect ส่งหาลูกค้า
GET/POST /internal/contacts/:ref/flags  ← ★ ของอีก session
```

---

## ★ ทุกอย่างปิดเป็นค่าตั้งต้น — deploy แล้วระบบทำงานเหมือนเดิมเป๊ะ

| env / สวิตช์ | ไม่ตั้ง = |
|---|---|
| `LINE_BROADCAST_LIVE` | **dry run ไม่แตะ network เลย** (ต้องเป็น `'1'` เป๊ะ ๆ · `'true'`/`'yes'`/`'1 '` = dry run) |
| `CONNECT_SERVICE_TOKEN` | `/internal/*` **ปิดสนิท** ไม่ใช่เปิดให้ทุกคน |
| `BROADCAST_TEST_ALLOWLIST` | ส่งทดสอบไม่ได้เลย |
| `ASHER_CRM_PUBLISH_ENABLED` | ตัวดูดคิวไป CRM ไม่เดิน (แต่ยังรายงานยอดค้างบน `/health`) |
| `ASHER_CRM_PUBLISH_BATCH` | 5 ใบ/รอบ (ของเดิมตั้งแข็ง 20 = ~400/นาที) |
| `LIFF_ID` / `LIFF_LOGIN_CHANNEL_ID` / `LIFF_CHANNEL_KEY` | หน้า `/liff` ตอบ 503 |
| `reply.flex_welcome_on_follow` (ใน `bot_config`) | ไม่ตอบอะไรตอนลูกค้าเพิ่มเพื่อน |

---

## ★★ บั๊กที่เจอ — ส่วนใหญ่สำคัญกว่าฟีเจอร์ที่สั่ง

| บั๊ก | ถ้าไม่เจอ |
|---|---|
| CHECK ของ `crm_publish_outbox.event_type` ตัดชนิดเดิมออก (2 ไฟล์) | **`ADD CONSTRAINT` ล้มทันทีบน production** เพราะตรวจแถวเดิมทั้งตาราง |
| `event_id` ของ outbox unique **ทั้งตาราง** ไม่ใช่ต่อชนิด | event ชนิดใหม่ถูก `ON CONFLICT DO NOTHING` **กลืนหายเงียบ ๆ** — postback ไม่เคยถูกเขียนลงคิวเลย |
| `crm_conversations.connect_contact_ref` เก็บ **LINE userId ไม่ใช่ uuid** | CRM **เรียก `/internal/contacts/<ref>/...` ไม่ได้เลยทุกเส้นทาง** |
| `crm_activities.source_event_id` เป็น uuid ไม่ใช่ text | transaction ล้ม → **outbox event หายพร้อมกันเงียบ ๆ** |
| **`crmPublisherWorker` หายจาก `server.mjs`** ตอน snapshot `20a7799` | คิวไป CRM ค้างสะสมตั้งแต่ **29 ก.ย.** ไม่มีใครดูด (กู้โค้ดแล้ว ยังไม่เปิด) |
| `lib/profile.mjs` ถูกย้อนรุ่นโดย snapshot เดียวกัน | ลูกค้าถูกป้ายว่า "ไม่พบผู้ใช้" ทั้งที่เป็นปัญหาสิทธิ์ (บั๊กที่เคยแก้แล้วกลับมา) |
| `lib/outbound-media.mjs` (ตัวเซ็นลิงก์รูป) **ไม่มีเทสต์เลย** | ด่านเดียวที่กันคนนอกดูดรูปลูกค้าจาก bucket ส่วนตัว |
| dispatch ของ CRM เป็น catch-all | ทุก event ชนิดใหม่ถูกเขียนลงตารางข้อความด้วย `sender_kind` undefined |
| seed ผูกกับเวลารัน migration | workspace ที่เกิดทีหลัง**ไม่มีกฎสักข้อ** ฟีเจอร์เงียบไปโดยไม่มีใครรู้ |
| `tests/static-files.test.mjs` parse ด้วย `\n` | พังทันทีที่มีใครแก้ไฟล์บนเครื่อง Windows (CRLF) |

★ **`20a7799` เป็นต้นเหตุ 4 จุด** — commit ที่ copy ไฟล์จาก VPS กลับเข้า repo (−870 บรรทัดใน `server.mjs`) พาของ **เก่ากว่า** เข้ามาด้วย
**เจออะไรแปลก ๆ ให้สงสัย commit นี้ก่อน**

**บั๊ก 5 ตัวมาจากการเขียนเทสต์ ไม่ใช่จากการอ่านโค้ด** — รวมถึงตัวที่จะทำให้ deploy ล้ม

---

## กับดักที่เจอแล้ว (เพิ่มจากของเดิม)

- **`ADD CONSTRAINT CHECK` ตรวจแถวเดิมทั้งตาราง** — มีสามไฟล์ที่ต่างก็ตั้ง CHECK ของ `crm_publish_outbox.event_type` ใหม่ทั้งก้อน **ตกค่าไปหนึ่งค่า = deploy ล้ม** (เตือนไว้ใน `ORDER.txt` แล้ว)
- **ลำดับทริกเกอร์บน `inbox.message` เรียงตามตัวอักษร** — `enqueue_outbound` < `trg_follow_welcome_flex` ซึ่งเป็นสิ่งที่ทำให้ "อัปเกรด payload เป็น Flex" ทำงานได้ ถ้าเปลี่ยนชื่อทริกเกอร์ต้องคิดเรื่องนี้
- **exception กลาง transaction ของ CRM** จะ rollback ทุกอย่างที่ทำไว้ก่อนในรอบเดียวกัน (contact, activity) — จึงต้อง "เลือกด้วย query" ไม่ใช่ "insert แล้วรับ error"
- **`crm_appointments` มี EXCLUDE** ห้ามเซลส์คนเดียวมีนัดซ้อนเวลา และ `owner_membership_id` เป็น NOT NULL
- **CSP ห้าม inline script** — หน้า LIFF ต้องโหลด SDK จาก `static.line-scdn.net` จึงตั้ง CSP เฉพาะหน้านั้น ไม่ผ่อน CSP ของหน้าแชท
- **ไฟล์ใหม่ใน `public/` ต้องลงทะเบียนใน `staticFiles`** (ของเดิม — ยังจริง)

---

## ผลทดสอบ (รันแล้ว)

```
Connect  node sql/run.mjs check                          ตรวจผ่าน
         ชุดที่ไม่พึ่งฐาน (liff/broadcast/crm-publisher/
         providers/profile/static-files/outbound-media/media-http)   112/112
         ชุดฐาน (broadcast.db / follow-welcome.db / service-outbound.db)  3/3

CRM      tsc --noEmit                                     ผ่าน
         appointments-liff 13/13 · handoff 13/13 · sales-handoff 10/10
         follow-lead 5 suites · รวมชุดใหญ่                 83/85
```

เทสต์ใหม่ ~90 ข้อ · ชุด DB รันบน Postgres จริงแบบ `BEGIN…ROLLBACK` (ไม่ค้างในฐาน) · **ไม่มีเทสต์ไหนยิง network จริง**

### ยังแดงและ **ไม่ใช่งานเซสชันนี้**
| | |
|---|---|
| CRM `appointment-workflow.test.ts` 2 ข้อ | `proposeAppointment` ส่ง param 8 ตัวแต่ query อ้างถึง `$9` (`ownerId` คำนวณแต่ไม่เคย bind) → `08P01` ทุกครั้ง · **ไม่แก้เพราะ main checkout มีงานค้างบนไฟล์นั้น** |
| Connect `report` 9 ข้อ · `outcomes` 3 ข้อ | ฐาน dev ในเครื่องขาด `012_report_weekly_sla.sql` (ของผสมรุ่น ไม่ใช่ prefix ของ ORDER.txt) — เสนอ 3 ทางเลือกไว้ใน Phase 0 audit |
| `instagram*` · `conversation-presentation` · `channel-badge-ui` | เทสต์ล้าหลังโค้ด อยู่นอก `npm test` — การลบ/เขียนใหม่ควรเป็นของเจ้าของฟีเจอร์ |

---

## เรื่องที่ "หยุดแล้วรายงาน" ไม่ลุยต่อ

1. **`BOUNDARIES.md` ขัดกับ production** — เขียนว่า tag/ดาวเป็นของ CRM แต่ของจริงอยู่ที่ Connect และขึ้น production แล้ว → แก้เอกสารให้ตรง + เตือนว่า **สเปก CRM บรรทัด 44–45 ยังสั่งสร้างระบบ tag ชุดที่สอง** (`crm_contact_tags` / `crm_contact_flags`) ซึ่งไม่ควรทำ
2. **`docs/asher-crm/DO-NOT.md` ขึ้นหัวว่า "รอบปัจจุบัน: documentation only"** — เขียน 18 ก.ย. ไม่เคยแก้ ขณะที่ repo มี implementation + snapshot production หลังจากนั้น → ตีความว่าค้าง จึงลงมือ **แต่ถ้าตีความผิด revert `c2168ca` ได้ทันที** (ไม่มี migration หลุดออกนอก sandbox)
3. **เบี่ยงจากสเปก 2 จุด เพราะ guardrail ที่ deploy แล้วบอกคนละอย่าง** — `source='line_follow'` ผิด `crm_leads_source_check` (ใช้ provider แล้วแยกด้วย activity แทน) · `reference_kind` ถูกจำกัดที่ 3 ค่า (ใช้ log + พัก receipt แทน)
4. **ไม่แตะฐาน dev ของผู้ใช้** — มีสองครั้งที่ sandbox บล็อก (`Modify Shared Resources`) รายงานไว้แล้วทั้งสองครั้ง

---

## ค้าง — ต้องให้ผู้ใช้ทำ (ไม่มีอะไรที่ทำต่อเองได้)

### ก่อน deploy — ขอข้อมูล 3 อย่าง (อ่านอย่างเดียว ปลอดภัย ฟรี)
```bash
cd /opt/asher-inbox/app && echo "deployed: $(cat .deployed-commit)" \
 && python3 -c "import json;[print(c['key'],'|',c['channel'],'|enabled=',c.get('enabled')) for c in json.load(open('channels.json'))]" \
 && docker exec supabase-db psql -U postgres -d postgres -X -t -c "select inbox.crm_publish_stats();"
```
★ **ยอด `pending` สำคัญที่สุด** — ถ้าหลักพันขึ้นไป **ห้ามเปิดตัวดูดทื่อ ๆ** จะยิง backlog ตั้งแต่ 29 ก.ย. เข้า CRM รวดเดียว (แผนเคลียร์ 2 แบบอยู่ใน Phase 0 audit ข้อ 5)

### ตัดสินใจ
| # | เรื่อง |
|---|---|
| 1 | **เปิด PR เข้า `hotfix/login-button-color` แล้ว deploy จาก merge commit** (คุณเลือกทางนี้ไว้แล้ว — ยังไม่ได้เปิด PR เพราะไม่ได้รับคำสั่ง) |
| 2 | โควตา OA: `@wdq0911k` รีช 2,690 แต่ฟรี 300/เดือน → ซื้อแพ็กเกจ หรือยอมเพดาน 300 · **ไม่บล็อกการ deploy/ทดสอบ** (ทดสอบทั้งหมดใช้ <1%) |
| 3 | ยืนยันการตีความ `DO-NOT.md` |
| 4 | เวลาทำการตั้งต้น 09:00–19:00 **ทุกวันรวมเสาร์อาทิตย์** — ยืนยันกับทีมขาย |

### งาน ops
| # | เรื่อง |
|---|---|
| 5 | deploy ตาม `docs/runbook/2026-10-line-broadcast-deploy.md` (SQL 5 ไฟล์) |
| 6 | ตั้ง `CONNECT_SERVICE_TOKEN` ให้ **ตรงกันสองฝั่ง** |
| 7 | ตั้ง `ASHER_CRM_PROJECT_MAP` — ไม่ตั้ง = follow ไม่เปิด lead เลย |
| 8 | สร้าง LIFF app ใน LINE Developers ชี้ endpoint มาที่ `https://inbox.apluscondo.com/liff` แล้วตั้ง 3 env |
| 9 | สร้าง tag 3 ตัวใน workspace จริง: `asher vibe` · `asher naii` · `ยังไม่แน่ใจ` |
| 10 | **เพิ่ม git remote ให้ `asher-crm`** ไม่งั้น 7 commit อยู่ในเครื่องเดียว |

### งานโค้ดที่เหลือ
| # | เรื่อง |
|---|---|
| 11 | **ยังไม่มีใครเรียก `runHandoffRound()` และ `runAppointmentReminders()`** — ต้องต่อ worker/cron (reminder ที่ 10:00 Asia/Bangkok) + ใช้ `createConnectClient` |
| 12 | แก้ `proposeAppointment` (bind `ownerId` เป็น `$4`) — เจ้าของงานที่ค้างใน main checkout |
| 13 | หน้าจอ campaign ฝั่ง CRM (สเปก CRM ส่วน B) ยังไม่ได้ทำ |
| 14 | ฐาน dev ในเครื่อง: เลือกแผน A/B/C ใน Phase 0 audit ข้อ 3 |
| 15 | Phase 5 (narrowcast / click-tracking / rich menu / drip) — roadmap สั่งให้แยก prompt |

---

## ไฟล์อ้างอิง

**Connect**
`docs/handoff/2026-10-02-phase0-audit.md` — ผลสำรวจงานค้าง + แผนฐาน dev + query นับ backlog
`docs/handoff/2026-10-02-line-broadcast-implementation.md` — รายละเอียด Phase 1 + env ใหม่ทั้งหมด
`docs/runbook/2026-10-line-broadcast-deploy.md` — **ขั้นตอน deploy ทีละขั้น + ผลที่ควรเห็น + ย้อนกลับ + ตารางค่าใช้จ่ายโควตา**
`docs/BOUNDARIES.md` — แก้ให้ตรงกับของจริง + เตือนจุดที่สเปก CRM ยังขัด

**CRM** (ใน worktree `asher-crm-follow-lead`)
`docs/handoff/2026-10-02-follow-lead.md` — Phase 2 + 3 + 4 ฝั่ง CRM ครบในไฟล์เดียว

**คำสั่งทดสอบ**
```bash
# Connect
npm run check
node --test tests/liff.test.mjs tests/broadcast.test.mjs tests/crm-publisher.test.mjs
ALLOW_DB_TESTS=1 node --test --test-concurrency=1 tests/broadcast.db.test.mjs \
  tests/follow-welcome.db.test.mjs tests/service-outbound.db.test.mjs

# CRM (ใน worktree · ต้องมี sandbox: npm run sandbox:up)
node --import tsx --test --test-concurrency=1 tests/service/follow-lead.test.ts \
  tests/service/sales-handoff.test.ts tests/service/handoff.test.ts \
  tests/service/appointments-liff.test.ts
```
★ worktree ของ CRM ไม่มี `node_modules` — ใช้ junction ชี้ไป `asher-crm/node_modules` (`DO-NOT.md` ห้าม `npm install`)
