# Phase 0 — เก็บงานค้าง: ผลสำรวจ + สิ่งที่แก้แล้ว

วันที่ 2026-10-02 · branch `feature/line-broadcast-sender` · roadmap: `line-roadmap-phases.md`
อ่านคู่กับ `docs/BOUNDARIES.md` · `docs/handoff/2026-10-02-line-broadcast-implementation.md`

> **ผลสรุปสั้น:** ปัญหาฝั่งโค้ด/เทสต์ **แก้หมดแล้ว** · ปัญหาฝั่ง DB ในเครื่อง **แก้ไม่ได้ด้วยของที่มีในรีโป** — ต้องให้ผู้ใช้ตัดสิน
> Phase 0 ยัง **ไม่ผ่านเกณฑ์** "เทสต์เขียวทั้งหมด" เพราะ `report` + `outcomes` ขึ้นกับรุ่นของฟังก์ชันในฐาน ไม่ใช่โค้ด

---

## ตารางสรุป

| # | ปัญหา | สาเหตุ | วิธีแก้ | บล็อก deploy? |
|---|---|---|---|---|
| 1 | `tests/media-http.test.mjs` import ของที่ไม่มี | `20a7799` ลบ `createPublicMediaHandler` — ท่อ `/media/public/` ถูกแทนด้วย `/outbound-media/` | **ลบเทสต์ของเก่า + ลบ `lib/media-public.mjs` ที่กำพร้า** ✅ ทำแล้ว | ไม่ |
| 2 | `tests/outbound-media.test.mjs` import ของที่ไม่มี | `20a7799` เขียน `lib/outbound-media.mjs` ใหม่ทั้งไฟล์ · การอัปโหลดหลายรูปย้ายไปคลังรูป | **เขียนเทสต์ใหม่ให้ตรง API ปัจจุบัน** ✅ ทำแล้ว | ไม่ (แต่สำคัญ — ดูหมายเหตุ) |
| 3 | `tests/profile.test.mjs:121` fail | `20a7799` **ย้อนรุ่น** `lib/profile.mjs` ทิ้ง Conversations fallback + การแยก code 100 / subcode 33 | **กู้โค้ดกลับ** (เทสต์คือสเปก) ✅ ทำแล้ว | ไม่ |
| 4 | `tests/providers.test.mjs:34` fail | เทสต์คาด `/<account_id>/messages` แต่โค้ดใช้ `/me/messages` ตามคอมเมนต์ที่ตั้งใจ — เข้ามาพร้อมกันตอน `20a7799` แต่คนละรุ่น | **แก้เทสต์ให้ตรงโค้ด** ✅ ทำแล้ว | ไม่ |
| 5 | `report` 9 ข้อ + `outcomes` 3 ข้อ fail | **ฐานในเครื่องเป็นของผสมรุ่น** ไม่ตรงกับจุดใด ๆ ใน `ORDER.txt` | ต้อง reset ฐาน — **รีโปไม่มีทางสร้างฐานใหม่จากศูนย์** ⛔ รอผู้ใช้ตัดสิน | **ไม่** (เป็นฐาน dev ไม่ใช่ VPS) |
| 6 | `sql/run.mjs check` แดง | 2 ไฟล์อยู่บนดิสก์แต่ไม่อยู่ใน `ORDER.txt` | เติมเข้าทะเบียน ✅ ทำแล้ว (commit ก่อน) | **ใช่ — ปลดแล้ว** |
| 7 | backlog ค้างใน `crm_publish_outbox` บน VPS | ไม่มีตัวดูดตั้งแต่ `20a7799` | นับก่อน แล้วค่อยเลือก drain/ข้าม — ดูหัวข้อ "backlog" | **ใช่** ถ้าจะกู้ worker พร้อมกัน |
| 8 | `instagram.test.mjs` 17 + `instagram-http` 1 fail · `conversation-presentation` 1 · `channel-badge-ui` 2 | `lib/instagram.mjs` กำพร้า (ไม่มีใคร import) · เทสต์ UI อ่าน `public/app.js` ที่เปลี่ยนไปแล้ว | **ยังไม่แตะ** — ไม่ได้อยู่ใน `npm test` และการลบคืองานของเจ้าของฟีเจอร์ | ไม่ |

**หมายเหตุข้อ 2 (สำคัญกว่าที่เห็น):** `lib/outbound-media.mjs` คือตัวเซ็นลิงก์ที่ทำให้ LINE/Messenger โหลดรูปจาก bucket ส่วนตัวได้โดยไม่มี session ของเรา — เป็นด่านเดียวที่กันคนนอกเดา path แล้วดูดรูปลูกค้า **และมันไม่มีเทสต์คลุมเลยตั้งแต่ `20a7799`** ตอนนี้มี 6 ข้อคลุม path traversal, หมดอายุ, แก้ลายเซ็น/เวลา/กุญแจแล้ว

---

## 1. ข้อค้าง 8 ข้อใน handoff — แยกประเภท

| # | เรื่อง | ประเภท | บล็อก deploy? |
|---|---|---|---|
| 1 | รัน SQL + deploy `202610021200_line_broadcast.sql` | **ops** | **ใช่ — เป็นตัว deploy เอง** |
| 2 | กู้ `crmPublisherWorker` | **โค้ด + ops** | ไม่บล็อกการ deploy ตัวส่ง · แต่ถ้าไม่ทำ event จะค้างในคิวตลอด |
| 3 | เปิด `LINE_BROADCAST_LIVE=1` | **ops** | ไม่ (ตั้งใจให้ deploy แบบ dry run ก่อน) |
| 4 | OA ไหน + เพดานโควตา (300/เดือน vs รีช 2,690) | **ธุรกิจ** | ไม่บล็อก deploy · **บล็อกการเปิด live** |
| 5 | thumbnail ของ `recent-messages` | **โค้ด** (ต้องตัดสินใจออกแบบก่อน) | ไม่ |
| 6 | `contact_ref` = `core.contact.id` จริงไหม | **ต้องยืนยันกับ CRM** | ไม่บล็อก deploy · บล็อกการใช้งานจริงจากฝั่ง CRM |
| 7 | เปิดปุ่มใน UI ของ Connect | **ธุรกิจ/boundary** | ไม่ |
| 8 | `docs/handoff/2026-09-30-release-gates.md` หาย | **เอกสาร** | ไม่ |

**ตัวบล็อก deploy จริงมีข้อเดียว: ข้อ 1** ที่เหลือรอได้หมด · ข้อ 4 บล็อกเฉพาะขั้น "เปิดยิงจริง"

---

## 2. `media-http.test.mjs` — `20a7799` ลบอะไร และควรคืนหรือลบ

`20a7799` คือการ copy ไฟล์จาก `/opt/asher-inbox/app` กลับเข้ารีโป — **ไม่ใช่ commit ที่ตั้งใจแก้อะไร** ผลคือมันพาทั้ง "ของใหม่ที่ไม่เคย commit" และ "ของเก่ากว่าที่อยู่บนเครื่อง" เข้ามาพร้อมกัน `server.mjs` เปลี่ยนไป **−870/+407 บรรทัด**

| ของที่หาย | ใครยังเรียก | คำตัดสิน |
|---|---|---|
| `createPublicMediaHandler` + route `/media/public/` | **ไม่มีใคร** — ถูกแทนด้วย `/outbound-media/` + `createOutboundMediaUrl` ซึ่งอยู่ใน `server.mjs` ปัจจุบันและบน production | **ลบเทสต์** |
| `lib/media-public.mjs` (`buildPublicMediaUrl`, `verifyPublicMediaToken`) | **เทสต์ตัวเองเท่านั้น** | **ลบไฟล์** — ทิ้งไว้คือกับดัก ให้คนหลงไปต่อท่อเซ็นชื่อชุดที่สองขนานกับ `outbound-media` |
| `validateOutboundImages` / `renderPayloads` | ไม่มี — การอัปโหลดหลายรูปกลายเป็นคลังรูป (`lib/media-library.mjs` · `planSendItems`) | **เขียนเทสต์ใหม่** ให้คลุม API ปัจจุบันแทน |
| `lib/profile.mjs`: Conversations fallback + code 100/subcode 33 | `server.mjs` เรียก `fetchProfile` อยู่ทุกวัน | **กู้กลับ** — โค้ดที่ถูกลบคือ *ตัวแก้บั๊กจริง* (คอมเมนต์ในโค้ดระบุว่า "ลูกค้า 57 ราย ถูกทำเครื่องหมายว่าไม่พบผู้ใช้ ทั้งที่เป็นปัญหาสิทธิ์") การย้อนรุ่นนี้เป็นอุบัติเหตุของ snapshot |
| `crmPublisherWorker` | ไม่มีแล้ว (เป็นเหตุของข้อค้างข้อ 2) | **แยกเป็นงานต่างหาก** — ดูหัวข้อ backlog |

★ **ข้อสังเกตที่ควรจำ:** `20a7799` เป็นแหล่งของ regression อย่างน้อย 4 จุด (media-public, outbound-media, profile, crmPublisher) สิ่งที่มันพามาเข้ารีโปคือ "สภาพบนเครื่อง" ไม่ใช่ "รุ่นที่ถูกต้อง" — เจออะไรแปลก ๆ ให้สงสัย commit นี้ก่อน

---

## 3. ฐานในเครื่อง drift — migration ที่ขาด และวิธี reset

### ที่ตรวจพบ

`inbox.sql_applied` (ทะเบียนของ `sql/run.mjs`) มี **2 แถว** เท่านั้น → ฐานนี้ไม่ได้ถูกสร้างด้วย `run.mjs` ตรวจจากวัตถุจริงแทน:

| กลุ่ม migration | วัตถุที่ตรวจ | ในเครื่อง |
|---|---|---|
| 016–018 stats | `inbox.stats_overview` | **ขาด** |
| 020 capture | `inbox.extract_referral` | **ขาด** |
| 021 outbox | `inbox.event_outbox` | **ขาด** (ตรงกับ ORDER.txt ที่ว่าไม่เคยลง) |
| 023 sla | `inbox.case_status` | มี |
| 024 queue_counts | `inbox.queue_counts` | **ขาด** |
| 029 logs | `inbox.logs_timeline` | **ขาด** |
| 031 test_reset | `connect_private.reset_test_conversation` | **ขาด** (แต่คอลัมน์ `conversation.is_test` ที่ 031 สร้าง **มี**) |
| 037 media | `connect_private.media_attach` | **ขาด** |
| 202609172025 health | `inbox.health_snapshot` | มี |
| 202609211300 crm publisher | `inbox.crm_publish_outbox` | **ขาด** |
| 202609231500 responder | `message.responder_display_name` | **ขาด** |
| 202609251000 monitor | `inbox.reply_alert` | มี |
| 202609261000 media library | `inbox.media_library_role` | **ขาด** |
| 202610011000 star/tags | `connect_private.contact_flag` | **ขาด** |
| 202610021000 contacts | `inbox.contacts_list` | **ขาด** |

### ★ สาเหตุที่แท้จริงของ `report` + `outcomes`

```
ในเครื่อง : inbox.reply_report(p_day date)                    ← รุ่นของ 009
            inbox.enqueue_daily_report(p_day date)             ← รุ่นของ 009
            build_reply_report_weekly / _monthly               ← ไม่มีเลย
ORDER.txt : inbox.reply_report(date, timestamptz default null) ← รุ่นของ 012 (มี sla + backlog + p90)
```

**ฐานขาด `012_report_weekly_sla.sql`** เทสต์เรียก `inbox.reply_report('2026-03-05')` แล้วไปโดนฟังก์ชันรุ่นเก่า จึงได้ `asked=5` แทน `6` · `outcomes` เพี้ยนด้วยเหตุเดียวกัน (`reply_episodes` คนละรุ่น)

### ⛔ ทำไมยังไม่ reset ให้

1. **ฐานนี้เป็นของผสมรุ่น ไม่ใช่ prefix ของ `ORDER.txt`** — มีของจาก `202609251000` (ใหม่) แต่ขาด `016–021`, `024`, `031`, `037` (เก่ากว่า) จะ "ไล่ลงไฟล์ที่ขาดตามลำดับ" ไม่ได้
2. **`ORDER.txt` เตือนเรื่องนี้ไว้เองด้วยเลือด** — การรัน `002` ทั้งไฟล์ซ้ำบนฐานที่มีของใหม่กว่า ทำให้ `connect_private.worker` เหลือ 8 จาก 21 action และ **ตัวส่งข้อความหาลูกค้าตายทั้งระบบ** เมื่อ 2026-09-16 (ดูหัวข้อ 032 ใน `ORDER.txt`) · `009` ก็เคยทับ `011` มาแล้ว (เหตุของ `034`)
3. **รีโปไม่มีทางสร้างฐานจากศูนย์** — `database.sql` (303 บรรทัด) สมมติว่ามี schema `inbox` / `core` / `crm` อยู่ก่อนแล้ว · `reference/inbox-schema.sql` เป็น pg_dump ของ schema เดียวไว้อ่าน ไม่ใช่ bootstrap · ไม่มี seed ของ `core.project`, `auth.users` (`sales.a.test@asher.local`) ที่เทสต์ต้องใช้

### ทางเลือกที่เสนอ (ต้องให้ผู้ใช้เลือก)

| | วิธี | ข้อดี | ข้อเสีย |
|---|---|---|---|
| **A** | ลง `012_report_weekly_sla.sql` ไฟล์เดียวบนฐานในเครื่อง | เร็ว · ปลด `report`+`outcomes` ได้น่าจะหมด | ฐานยัง "ผสมรุ่น" ต่อไป แค่ผสมคนละแบบ · `012` สั่ง `cron.unschedule`/`schedule` 3 งานด้วย |
| **B** | สร้างฐานใหม่จาก `pg_dump` ของ VPS แล้วไล่ `ORDER.txt` ส่วนที่ขาด | ตรงกับของจริงที่สุด | ต้องดึง dump จาก VPS = งาน ops + มีข้อมูลลูกค้าจริงลงเครื่อง (ต้องตัดสินเรื่อง PDPA ก่อน) |
| **C** | ไม่แตะฐาน ยอมรับว่า `report`/`outcomes` รันได้เฉพาะบนฐานที่ตรงรุ่น | ไม่เสี่ยงอะไรเลย | `npm test` ไม่มีวันเขียวในเครื่องนี้ |

**ที่แนะนำ: A ก่อน** (ย้อนกลับได้ — นิยามเดิมอยู่ใน `009_report.sql`) แล้วค่อยวางแผน B เป็นงาน ops แยก
**ยังไม่ทำให้ เพราะเป็นการแก้ฐานของผู้ใช้ และผลพลอยได้คือ cron ในเครื่องถูกตั้งใหม่**

---

## 4. `hotfix/login-button-color` — merge แล้ว ไม่ชนกัน

```
origin/hotfix/login-button-color = 045b9b4  "Merge production 4a5482d: contacts page, customer drawer, LINE OA-style menu"
4a5482d (production) เป็น ancestor แล้ว  → ข้อค้างข้อ 1 ของ session handoff เดิม ปิดแล้ว
git rev-list --left-right --count origin/hotfix/login-button-color...feature/line-broadcast-sender  →  0  1
```

**แปลว่า:** branch งานนี้ = `hotfix/login-button-color` + commit ของเราล้วน ๆ **ไม่มี commit ฝั่งนั้นที่เราไม่มี → ไม่มีโอกาส conflict เลย** (merge เป็น fast-forward ได้)
★ `origin/main` คือ `ab2f655 "first commit"` — ว่างเปล่า ไม่ใช่สาย production อย่าเผลอ merge ไปที่นั่น

---

## 5. backlog ใน `crm_publish_outbox` บน VPS — query นับ (read-only) + แผนเคลียร์

> **ยังไม่ได้รัน** ตามที่สั่ง · ให้ผู้ใช้รันบน VPS แล้ววางผลกลับมา

### นับก่อน (อ่านอย่างเดียว ไม่เขียนอะไรเลย)

```bash
docker exec supabase-db psql -U postgres -d postgres -X -c "
select status, count(*),
       min(created_at) as oldest, max(created_at) as newest
  from inbox.crm_publish_outbox
 group by status order by 2 desc;"
```

```bash
# แยกตามชนิดและตามวัน — ดูว่า backlog โตวันละเท่าไร และเป็น event อะไรบ้าง
docker exec supabase-db psql -U postgres -d postgres -X -c "
select event_type, date_trunc('day', created_at)::date as day, count(*)
  from inbox.crm_publish_outbox
 where status in ('pending','processing')
 group by 1,2 order by 2 desc, 3 desc limit 40;"
```

```bash
# สรุปสำเร็จรูปที่ฟังก์ชันเดิมให้มาอยู่แล้ว
docker exec supabase-db psql -U postgres -d postgres -X -c "select inbox.crm_publish_stats();"
```

### ตีความผล

| ถ้าเห็น | แปลว่า | ทำอะไรต่อ |
|---|---|---|
| `pending` หลักสิบ–ร้อย | ท่อหยุดไม่นาน | กู้ worker แล้วปล่อยดูดได้เลย |
| `pending` หลักพันขึ้นไป · `oldest` ย้อนไปถึง ~29 ก.ย. | ค้างตั้งแต่ `20a7799` | **ห้ามเปิด worker ทื่อ ๆ** — เลือกแผนข้างล่าง |
| มี `processing` ค้างที่ `lease_until` เก่ามาก | เคยมี worker ตายกลางคัน | `crm_publish_claim` หยิบกลับเองได้ ไม่ต้องแก้มือ |

### แผนเคลียร์ — เลือกอย่างใดอย่างหนึ่ง (ยังไม่ต้องรัน)

**แผน 1 — ข้ามของเก่า แล้วเริ่มนับหนึ่งใหม่** (แนะนำถ้า backlog ใหญ่)
CRM มีข้อความเก่าจากช่วงนั้นอยู่แล้วหรือไม่ก็ไม่ต้องการย้อนหลัง → ปิดของเก่าทิ้งโดยไม่ส่ง
```sql
-- ★ เขียนข้อมูล — backup ก่อน และรันเมื่อผู้ใช้ตัดสินใจแล้วเท่านั้น
begin;
  update inbox.crm_publish_outbox
     set status = 'dead_letter', last_error_code = 'skipped_backlog_20261002'
   where status in ('pending','processing')
     and created_at < timestamptz '2026-10-02 00:00+07';
  -- ตรวจยอดก่อน commit
  select status, count(*) from inbox.crm_publish_outbox group by 1;
commit;
```
กู้ได้: แถวยังอยู่ครบ เปลี่ยน `status` กลับเป็น `pending` เมื่อไรก็ได้ (คัดจาก `last_error_code`)

**แผน 2 — ดูดทีละชุด คุมความเร็วเอง**
`crm_publish_claim(p_limit, p_lease_seconds)` รับได้สูงสุด 100/ครั้งอยู่แล้ว → กู้ `crmPublisherWorker` แล้วตั้ง limit ต่ำ ๆ (เช่น 5) + ช่วงเดินห่าง ๆ ก่อน แล้วค่อยเร่ง
ข้อควรระวัง: `crm_publish_finish` มี `attempts >= 6 → dead_letter` อยู่แล้ว ของที่ CRM ปฏิเสธจะไม่วนไม่สิ้นสุด

**ไม่ว่าแผนไหน:** ต้องรู้ยอดจาก query ข้างบนก่อน และต้อง `pg_dump` ก่อนแตะ

---

## สิ่งที่แก้ในรอบนี้ (commit แยกตามเรื่อง)

| commit | เรื่อง |
|---|---|
| 1 | ลบท่อ `/media/public/` ที่ตายแล้ว (`lib/media-public.mjs` + เทสต์) |
| 2 | เขียน `tests/outbound-media.test.mjs` ใหม่ให้คลุมตัวเซ็นลิงก์ที่ใช้จริง |
| 3 | กู้ Messenger Conversations fallback + code 100/subcode 33 ใน `lib/profile.mjs` |
| 4 | แก้ assertion ของ Instagram ใน `tests/providers.test.mjs` ให้ตรงกับ `/me/messages` |

### ผลเทสต์หลังแก้

```
node sql/run.mjs check   ตรวจผ่าน

auth 2/2 · profile 18/18 · providers 41/41 · bots 22/22 · testcmd 15/15
decide 38/38 · media 11/11 · media-http 4/4 · broadcast 18/18
outbound-media 6/6 · media-library 17/17 · sla 18/18 · case-flags 5/5
case-flags-ui 12/12 · static-files 2/2 · quotation-image 7/7 · quotation-link 2/2
notify-test-prefix 12/12 · customer-contact-extraction 3/3 · return-to 1/1

report      8/17   ← ฐานขาด 012  (ข้อ 3 ข้างบน)
outcomes   11/14   ← ฐานขาด 012  (ข้อ 3 ข้างบน)
```

ยังแดงและ **ไม่ได้แตะ** (อยู่นอก `npm test` ทั้งหมด):
`instagram` 0/17 + `instagram-http` 0/1 (`lib/instagram.mjs` กำพร้า — ไม่มีใคร import นอกจากเทสต์ตัวเอง · ทางส่งจริงคือ `providers.mjs sendInstagram`) ·
`conversation-presentation` 7/8 และ `channel-badge-ui` 0/2 (assert เนื้อ `public/app.js` ที่เปลี่ยนไปตั้งแต่ทำเมนูแบบ LINE OA) ·
`http.integration.mjs` (ต้องมีไฟล์ `.env`)

> ทั้งสามกลุ่มนี้เป็น "เทสต์ที่ล้าหลังโค้ด" ไม่ใช่โค้ดพัง — แต่การตัดสินว่าจะลบหรือเขียนใหม่ควรเป็นของเจ้าของฟีเจอร์ ไม่ใช่ลบให้เขียวเฉย ๆ

---

## เกณฑ์ผ่าน Phase 0 — สถานะ

| เกณฑ์ | สถานะ |
|---|---|
| `node sql/run.mjs check` ผ่าน | ✅ |
| เทสต์ฝั่งโค้ดล้วนเขียวหมด | ✅ |
| เทสต์ที่ขึ้นกับฐานเขียว | ❌ **รอผู้ใช้เลือกแผน A/B/C ในข้อ 3** |
| handoff เหลือแต่งาน ops | ⚠️ เหลืองาน ops 4 ข้อ (1,2,3,4) + งานโค้ด 1 ข้อ (5 thumbnail) + ต้องยืนยันกับ CRM 1 ข้อ (6) |
| branch ไม่ปนกัน | ✅ ไม่มีโอกาส conflict กับ `hotfix/login-button-color` |
