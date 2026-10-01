# Handoff — ติดดาวลูกค้า Potential · ติดตาม · Tag แบบ LINE OA (1 ต.ค. 2569)

สถานะ: **เฟส 1 เขียนโค้ด/SQL แล้ว (ดู "ผลการลงมือ เฟส 1" ท้ายไฟล์) · ยังไม่ได้ deploy · เฟส 2 ยังไม่ทำ** · ทำบน production คือ VPS `inbox.apluscondo.com` (Hostinger) ไม่ใช่ Supabase Cloud เดิม

## เป้าหมาย (ตามที่ผู้ใช้ขอ)

ใน Sales Workspace ของ asher-connect:
1. **ติดดาว** ลูกค้าที่เป็น potential — กดดาวบนการ์ดเคส/หัวแชท มีตัวกรอง "ติดดาว"
2. **การติดตาม** — ตั้งวันเวลาติดตาม + โน้ตสั้น ๆ, มีตัวกรอง "ถึงเวลาติดตาม", เตือนเมื่อถึงเวลา
3. **Tag แบบ LINE OA Manager** — ป้ายสีที่ทีมสร้างเอง (เช่น `สนใจ 1BR`, `นัดชมแล้ว`, `นักลงทุน`, `ต่างชาติ`) ติดได้หลายป้ายต่อเคส, กรองตาม tag ได้, ใช้ได้ทุกช่องทาง (LINE / Messenger / IG)

## สภาพปัจจุบัน (ตรวจจากโค้ด HEAD `fe29fea` + working tree)

- มี `connect_private.case_state.follow_up_at` แล้ว · บันทึกผ่าน `connect_api` action `save` (ฟอร์ม `#followup` ใน lead card) และสร้าง `crm.activity` type `task` source `connect_followup`
- ตัวกรอง `followup` มีใน `connect_private.api` กิ่ง `list` (`s.follow_up_at<=now()`) และป้าย "ติดตามเลยกำหนด" บนการ์ด (`dueAlerts` ใน `public/app.js`)
- **ยังไม่มี**: ดาว, tag, โน้ตติดตาม, การเตือนเมื่อถึงเวลา
- ★ `connect_private.api` ถูก `create or replace` ทั้งก้อนมาแล้วหลายไฟล์ และ **ตัวบน VPS ใหม่กว่า repo** (ดู memory/handoff Meta review 20 ก.ย.) → **ห้ามเขียนทับ `connect_private.api` ในงานนี้**
- pattern ที่ใช้แทน: ฟังก์ชันแยก + `rpcDirect(accessToken, ...)` ใน `server.mjs › handleCommand` (แบบ `queue_counts`, `pending_reply_preview`, `media_library_*`) — ยิงด้วย token ของคนที่ล็อกอิน, ด่านสิทธิ์อยู่ในฐานผ่าน `connect_private.can_read()`
- Working tree **dirty** (contact-contract, profile, notify ฯลฯ) — ห้าม reset/checkout ทับ, ห้าม deploy dirty tree; ทำงานนี้บน branch แยก `feat/star-follow-tags`

## ข้อจำกัดของแพลตฟอร์ม (ต้องรู้ก่อนเริ่ม)

- **LINE Messaging API ไม่มี API สำหรับ chat tag ของ LINE OA Manager** → tag ที่ติดในแอป LINE OA จะไม่ไหลเข้ามา และ tag ของเราไม่ไหลกลับไป · ระบบนี้เป็นแหล่งความจริงของ tag เอง (เหมือน LINE แต่อยู่ใน Connect)
- Meta ก็เช่นกัน — ไม่ sync label ไป Business Suite ในเฟสนี้
- ถ้าอนาคตอยากแยกกลุ่มส่ง broadcast ใน LINE ค่อยใช้ Audience API แยกต่างหาก (นอกขอบเขต)

## การออกแบบ

### ระดับของข้อมูล
- ทีมตอบแบบ **shared queue** → ดาวและ tag เป็น **ของทีม ผูกกับลูกค้า (contact)** ไม่ใช่ของคนใดคนหนึ่ง
- ผูกที่ `core.contact` (ไม่ใช่ conversation) เพื่อให้ลูกค้าคนเดียวที่ทักหลายช่องทาง (unified identity) เห็นดาว/tag เดียวกัน · การ์ดเคสแสดงผ่าน `conversation.contact_id`

### Migration ใหม่ `sql/202610011000_contact_star_tags.sql` (additive, รันซ้ำได้)

```sql
-- ดาว + โน้ตติดตาม (1 แถวต่อ contact)
create table if not exists connect_private.contact_flag (
  contact_id   uuid primary key references core.contact(id) on delete cascade,
  starred      boolean not null default false,
  starred_by   uuid, starred_at timestamptz,
  follow_note  text check (char_length(follow_note) <= 500),
  updated_at   timestamptz not null default now()
);
-- นิยาม tag (ทีมสร้างเอง แบบ LINE OA)
create table if not exists connect_private.tag (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 30),
  color text not null default 'grey',      -- palette ตายตัว: grey/blue/green/amber/purple/pink/teal  (ห้ามใช้แดงแบรนด์ #8E1116 — สงวนไว้ให้ SLA/error)
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_by uuid, created_at timestamptz not null default now()
);
create unique index if not exists tag_name_uq on connect_private.tag (lower(btrim(name))) where is_active;
-- ความสัมพันธ์ contact ↔ tag
create table if not exists connect_private.contact_tag (
  contact_id uuid references core.contact(id) on delete cascade,
  tag_id uuid references connect_private.tag(id) on delete cascade,
  tagged_by uuid, tagged_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);
create index if not exists contact_tag_tag_idx on connect_private.contact_tag(tag_id);
create index if not exists contact_flag_starred_idx on connect_private.contact_flag(contact_id) where starred;
-- RLS on + revoke ทั้งหมด ตามแบบ database.sql; เข้าถึงผ่าน security definer functions เท่านั้น
```
Seed tag เริ่มต้น (ผู้ใช้ปรับได้ภายหลัง): `Hot`, `สนใจ 1BR`, `สนใจ 2BR`, `นักลงทุน`, `ต่างชาติ`, `นัดชมแล้ว`, `รอกู้/รอเอกสาร`

### ฟังก์ชัน (schema `inbox`, `security definer`, `set search_path=''`, ตรวจ `connect_private.can_read(conversation_id)` ทุกครั้ง)

| ฟังก์ชัน | ทำอะไร | สิทธิ์ |
|---|---|---|
| `inbox.case_star(p jsonb)` `{conversation_id, starred}` | ติด/ถอดดาวที่ contact ของเคส | ทุก role ที่ `can_read`; test_only แก้ได้เฉพาะ `is_test` |
| `inbox.case_follow(p jsonb)` `{conversation_id, follow_up_at, note}` | ตั้ง/ล้างวันติดตาม + โน้ต · เขียน `case_state.follow_up_at` **และ** ปิด/สร้าง `crm.activity` task แบบเดียวกับ action `save` เดิม (source `connect_followup`) เพื่อไม่ให้ CRM แตกกันสองทาง · ใช้ `case_state.version` กันเขียนชนกัน | เหมือนข้างบน |
| `inbox.case_tags_set(p jsonb)` `{conversation_id, add:[tag_id], remove:[tag_id]}` | ติด/ถอด tag | เหมือนข้างบน |
| `inbox.tags_list()` | รายการ tag ที่ active + จำนวนเคสที่ติด | ทุกคน |
| `inbox.tag_upsert(p)` / `inbox.tag_archive(p)` | สร้าง/แก้ชื่อ/สี/ลำดับ, เลิกใช้ (soft) | **ต้องให้ผู้ใช้ยืนยัน** — เสนอ: sales สร้างได้ (เหมือน LINE), แก้ชื่อ/ลบได้เฉพาะ manager/admin |
| `inbox.case_flags(p jsonb)` `{conversation_ids:[...]}` | คืน `{id → {starred, tags:[{id,name,color}], follow_up_at, follow_note}}` สำหรับตกแต่งการ์ดในหน้าที่โหลดอยู่ (≤ 51 id) | กรองด้วย `can_read` |
| `inbox.flag_list(p jsonb)` `{filter:'starred'|'tag'|'followup_due', tag_id, search, offset}` | คืนแถวรูปเดียวกับกิ่ง `list` ของ `connect_private.api` (copy คอลัมน์ select ตัวปัจจุบันบน VPS) สำหรับตัวกรองใหม่ — เรียง `last_message_at desc`, limit 51 | กรองด้วย `can_read` + `(not test_only or is_test)` |

ทุกการเปลี่ยนแปลงลง `connect_private.audit` (action `star`/`unstar`/`follow`/`tag_add`/`tag_remove`/`tag_admin`)

### server.mjs
ใน `handleCommand` เพิ่ม allow-list (แบบ `STATS_ACTIONS`):
```js
const FLAG_ACTIONS = new Set(['case_star','case_follow','case_tags_set','tags_list','tag_upsert','tag_archive','case_flags','flag_list'])
if (FLAG_ACTIONS.has(input.action)) return json(res, 200, await rpcDirect(accessToken, input.action, { p: input.data }))
```
(`tags_list` ไม่มี arg — ให้ฟังก์ชันรับ `p jsonb default '{}'` เพื่อ signature เดียวกัน)

### UI (`public/app.js`, `app.css`, `index.html`)
แนวทางตาม memory: การ์ดขาว, สีอยู่ที่ป้ายเล็ก/ชิปเท่านั้น, compact, แดงแบรนด์สงวนไว้ให้ SLA เกินเท่านั้น · อ้างอิง Meta Business Suite "Follow up" ★ + LINE OA chat tags
- **การ์ดเคส**: ไอคอน ☆/★ มุมขวาบน (คลิกได้ทันที ไม่เปิดแชท, optimistic update + rollback ถ้า error) · tag แสดงเป็นจุดสี+ชื่อย่อ สูงสุด 2 อัน `+N` · ถ้ามีวันติดตามแสดง `⏰ 3 ต.ค.` (เลยกำหนด = ป้ายอำพัน ไม่ใช่แดง)
- หลัง `loadList()` เรียก `case_flags` ครั้งเดียวด้วย id ทั้งหน้า แล้ว merge
- **หัวแชท**: ปุ่มดาว + แถว tag chips + ปุ่ม `＋ Tag` เปิด popover (ค้นหา, ติ๊กหลายอัน, "สร้าง tag ใหม่ ‘…’" ถ้าพิมพ์แล้วไม่เจอ — เหมือน LINE)
- **Lead card**: ย้ายช่อง "ติดตามครั้งถัดไป" ไปเป็นบล็อก "การติดตาม" — ปุ่มลัด `พรุ่งนี้ 10:00` `3 วัน` `1 สัปดาห์` `กำหนดเอง` + โน้ต + ปุ่ม `เสร็จแล้ว` (ล้างวัน) · บันทึกผ่าน `case_follow` ไม่ใช่ `save` (ตัด `follow_up_at` ออกจาก payload ของ `save` เพื่อไม่ให้สองทางเขียนชนกัน — ตรวจว่า `save` บน VPS ยอมให้ไม่ส่ง key นี้โดยไม่ล้างค่า; ถ้า `nullif(p_data->>'follow_up_at','')` จะ **ล้างค่าเป็น null** → ต้องส่งค่าปัจจุบันกลับไปด้วยจนกว่าจะแก้)
- **ตัวกรอง**: เพิ่มชิป `★ ติดดาว` และ dropdown `Tag ▾` ข้างชิปเดิม · `ถึงเวลาติดตาม` ใช้ตัวเดิม · ตัวกรองใหม่ยิง `flag_list` แทน `list` · `queue_counts` ยังไม่ต้องนับตัวใหม่ (เฟส 2)
- หน้า **จัดการ Tag** (เล็ก ๆ ในเมนู admin หรือ modal): ชื่อ, สีจาก palette, ลำดับ, เลิกใช้

### การเตือนเมื่อถึงเวลาติดตาม (เฟส 2 — ทำหลังเฟส 1 ผ่าน)
- worker ใน asher-connect ทุก 5 นาที: เคสที่ `follow_up_at <= now()` และยังไม่เคยเตือนรอบนี้ → ส่งเข้ากลุ่ม Telegram ทีมขาย (ทางเดียวกับ `bots/notify.mjs`) พร้อมลิงก์ `https://inbox.apluscondo.com/conversations/<id>`
- กันเตือนซ้ำด้วยคอลัมน์ `connect_private.contact_flag.follow_notified_for timestamptz` = ค่า follow_up_at ที่เตือนไปแล้ว
- ไม่เตือนช่วง 00:00–06:00 (ตามกติกา SLA) — เลื่อนไปส่ง 06:00

## ลำดับงาน (TDD ทีละ slice ตาม convention ใน `2026-09-30-release-gates.md`)

1. Branch `feat/star-follow-tags` จาก `fe29fea` (ไม่เอางาน dirty ติดมา)
2. SQL migration + DB test บน isolated DB (`tests/*.db.test.mjs` แบบ `contact-contract.db.test.mjs`) — ครอบ: can_read กันคนนอก, test_only, ชื่อ tag ซ้ำ, ดาวข้ามช่องทางของ contact เดียวกัน, `case_follow` ไม่ทำให้ crm.activity ซ้อน
3. เพิ่ม `ORDER.txt` ต่อท้าย + `node sql/run.mjs check`
4. server.mjs routing + unit test ว่า action นอก allow-list ไม่ผ่าน
5. UI การ์ด/หัวแชท/lead card/ตัวกรอง → ทดสอบในเบราว์เซอร์ทั้ง desktop และ mobile width
6. `npm test` ผ่านทั้งชุด

## Deploy บน VPS (manual ตาม `docs/deploy.md`)

1. Backup ก่อน: `docker exec supabase-db pg_dump -U postgres -d postgres -n connect_private -n inbox > /opt/asher-inbox/pre-star-tags.$(date +%Y%m%d-%H%M).sql`
2. รัน SQL ด้วยมือ (deploy script ไม่รัน migration):
   `docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < sql/202610011000_contact_star_tags.sql`
3. ก่อนรัน copy คอลัมน์ select ของ `flag_list` ให้ตรงกับ `pg_get_functiondef('connect_private.api'...)` **ตัวบน VPS** ไม่ใช่ใน repo
4. `git archive` commit → scp → extract `/opt/asher-inbox/app` → `.deployed-commit` → `docker compose build && docker compose up -d`
5. Smoke: ติดดาว/tag/ติดตาม จาก login ake@ และ login sales ทดสอบ, ตรวจ reviewer login (`meta-review@`) ยังเห็นเฉพาะ `is_test`
6. บันทึกลง `inbox.sql_applied` ว่ารันไฟล์นี้ด้วยมือแล้ว

## คำถามที่ต้องให้ผู้ใช้ตัดสิน (ยังไม่ได้ถาม)

1. Sales สร้าง tag ใหม่เองได้ไหม หรือให้ manager/admin สร้างเท่านั้น (LINE ให้ทุกคนสร้างได้)
2. ดาวเป็นของทีม (ทุกคนเห็นดาวเดียวกัน) — ถูกต้องไหม หรืออยากให้มีดาวส่วนตัวด้วย
3. tag/ดาวควรส่งต่อไป Asher CRM (`asher-crm`) ผ่าน outbox เดิมด้วยไหม — ถ้าใช่ เพิ่ม event `contact_flags_updated` ในเฟส 2
4. รายการ tag เริ่มต้นข้างบนโอเคไหม

---

## ผลการลงมือ เฟส 1 (1 ต.ค. 2569)

Branch `claude/cool-turing-zcfief` แตกจาก `fe29fea` (`connect-profile-content`) ไม่มีงาน dirty ติดมา · **ยังไม่ได้รันบน VPS**

### คำถาม 4 ข้อ — ใช้ค่าที่เสนอไว้ (ยังไม่มีคำตอบจากผู้ใช้ แก้ได้ภายหลัง)
1. Sales **สร้าง** tag ได้ (แบบ LINE) · แก้ชื่อ/สี/ลำดับ/เลิกใช้ได้เฉพาะ manager/admin · ผู้ตรวจสอบ (test_only) สร้างไม่ได้
2. ดาวเป็นของทีม ผูกกับลูกค้า — ไม่มีดาวส่วนตัว
3. **ไม่ส่ง** ดาว/tag ไป Asher CRM ในเฟสนี้ (ถ้าต้องการ เพิ่ม event `contact_flags_updated` ในเฟส 2)
4. tag เริ่มต้น 7 อันตามรายการข้างบน

### ไฟล์
| ไฟล์ | ทำอะไร |
|---|---|
| `sql/202610011000_contact_star_tags.sql` | 3 ตาราง + seed tag + ฟังก์ชัน `inbox.case_star/case_follow/case_tags_set/tags_list/tag_upsert/tag_archive/case_flags/flag_list` + ตัวช่วยภายใน 3 ตัว (ไม่เปิดให้ authenticated) · รันซ้ำได้ · ไม่แตะ `connect_private.api` |
| `sql/ORDER.txt` | ต่อท้ายไฟล์ข้างบน · `node sql/run.mjs check` ผ่าน |
| `lib/case-flags.mjs` + `server.mjs` | allow-list `FLAG_ACTIONS` → `rpcDirect(accessToken, fn, { p })` |
| `public/case-flags.mjs` | ส่วนที่ไม่แตะ DOM (palette, ปุ่มลัดเวลาไทย, ป้าย ⏰, ค้นหา tag, diff) |
| `public/app.js` · `app.css` · `index.html` | ☆/★ บนการ์ด+หัวแชท, tag บนการ์ด (≤2 +N) + popover แบบ LINE, ชิป `★ ติดดาว` `⏰ ถึงเวลาติดตาม` `Tag ▾`, บล็อก "การติดตาม" ใน lead card, dialog จัดการ Tag |
| `tests/star-follow-tags.db.test.mjs` | DB contract — ดาวข้ามช่องทาง, tag ซ้ำ, สิทธิ์ sales/manager, version กันชน, crm.activity ไม่ซ้อน, test_only, คนนอก · ทุกอย่างอยู่ใน transaction แล้ว ROLLBACK |
| `tests/case-flags.test.mjs` · `tests/case-flags-ui.test.mjs` | allow-list, ชื่อฟังก์ชัน/grant ตรงกับ SQL, palette ตรง constraint, เวลาไทยของปุ่มลัด, save ยังส่ง follow_up_at |

### ต่างจาก spec ข้างบน (ตั้งใจ)
- **`case_follow` ไม่ต้องรับเคสก่อน** (ด่านคือ `can_read`) ต่างจาก `save` · เขียน `crm.activity` เฉพาะเมื่อวันเปลี่ยนและเคสมี lead แล้ว — ไม่เรียก `ensure_lead` (มันสร้าง lead และ raise ถ้า pipeline ไม่พร้อม) · คืน `version` ใหม่ให้หน้าจอ ฟอร์มข้อมูลลูกค้าจึงบันทึกต่อได้ไม่ชน `version_conflict`
- **ฟอร์ม `save` ยังส่ง `follow_up_at` ค่าปัจจุบัน** (`detail.state.follow_up_at`) เพราะ `save` ทำ `nullif(...)` = ไม่ส่งคือล้างค่า — ตามที่ spec เตือนไว้
- **`tags_list` คืน `{tags, starred, can_manage, can_create}`** ไม่ใช่แค่ array — ใช้ตัวเลขบนชิป `★ ติดดาว` โดยไม่ต้องแก้ `queue_counts`
- **ชิป `⏰ ถึงเวลาติดตาม` ใช้ตัวกรอง `followup` เดิมของกิ่ง `list`** — `flag_list` จึงรับแค่ `starred` | `tag` (ไม่มี `followup_due` ซ้ำซ้อน)
- **`flag_list` รวมเคสที่ปิดแล้ว** — ดาว/tag เป็นของลูกค้า ไม่ใช่ของคิว
- **ป้ายแดง "ติดตามเลยกำหนด" เดิม (`dueAlerts`) ถูกเอาออก** เหลือแต่ "ถึงเวลานัดหมาย" — มีป้าย ⏰ สีอำพันแทน ไม่งั้นจะซ้ำสองป้ายและเป็นแดงที่สงวนไว้ให้ SLA
- การ์ดที่มี tag/วันติดตามได้แถวที่สาม (สูง 82px แทน 64px) และถ้ามี ⏰ จะโชว์ tag 1 อัน +N — คอลัมน์รายการแคบเกินกว่าจะใส่ 2 อันพร้อม ⏰
- เมนู `Tag ▾` วางที่ `body` แบบ fixed — `#filters` เป็นตัวเลื่อนแนวนอน เมนูข้างในจะถูกตัด

### ตรวจแล้ว
- `npm run check` ผ่าน · unit test ที่รันได้ในเครื่องที่ไม่มี docker ผ่านทั้งหมด
- DB test รันกับ Postgres 16 ที่จำลอง schema ขั้นต่ำ (ไม่ใช่ supabase จริง) ผ่าน · ลอง mutate ตัด `can_read` ออกจาก `case_flags` แล้วเทสต์จับได้ · migration รันซ้ำสองรอบไม่พัง seed ไม่ซ้ำ
- เบราว์เซอร์ (Playwright, 1400px และ 390px, API จำลอง): ติดดาวจากการ์ดไม่เปิดแชท + อีกช่องทางของลูกค้าเดียวกันติดดาวตาม, ชิปติดดาว, สร้าง tag ใหม่จาก popover, ปุ่มลัด 3 วัน → 10:00 เวลาไทย, กดบันทึกข้อมูลต่อได้ด้วย version ใหม่, กรองตาม tag + URL `?filter=tag-<id>`, dialog จัดการ Tag — ไม่มี JS error
- **ยังไม่ได้ทดสอบกับ supabase จริง** — ก่อน deploy ให้รัน `ALLOW_DB_TESTS=1 node --test tests/star-follow-tags.db.test.mjs` บนเครื่องที่มี `supabase-db`

### ก่อน deploy (เพิ่มจากหัวข้อ Deploy ข้างบน)
- ข้อ 3 ยังต้องทำ: เทียบคอลัมน์ `select` ของ `inbox.flag_list` กับกิ่ง `list` ของ `connect_private.api` **ตัวบน VPS** — ไฟล์นี้คัดมาจาก `202609221400_manual_name_guard.sql` ใน repo
- ตรวจว่า `core.profile.test_only` และ `inbox.conversation.is_test` มีบน VPS แล้ว (มาจาก sql/041, sql/031)
- โพลทุก 10 วินาทีตอนนี้ยิงเพิ่มอีก 2 ตัว (`case_flags`, `tags_list`) — ถ้าฐานหนัก ค่อยลดความถี่ของ `tags_list`

### เฟส 2 (ยังไม่ทำ)
เตือน Telegram เมื่อถึงเวลาติดตาม (`follow_notified_for`, เว้น 00:00–06:00), นับดาว/tag ใน `queue_counts`, sync ไป Asher CRM ถ้าผู้ใช้ตอบข้อ 3 ว่าต้องการ
