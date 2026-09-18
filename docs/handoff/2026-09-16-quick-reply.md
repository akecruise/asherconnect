# Handoff — Quick Reply (Phase 8.5) · สำรวจครบ ยังไม่เขียนโค้ด

16 กันยายน 2026 (ค่ำ) · เขียนโดย session สำรวจ · ผู้รับงาน: session ถัดไป / Ake

**สถานะ: ยังไม่มีโค้ด quick_reply แม้บรรทัดเดียวในทั้งสอง repo** — session นี้ทำถึงแค่: อ่านสเปก,
สำรวจโครงจริงสองฝั่ง (read-only), เก็บเอกสารเข้า repo, และล็อกการตัดสินใจกับผู้ใช้แล้ว 4 ข้อ

อ่านหัวข้อ 0 ก่อนแตะอะไร · สเปกต้นทางอยู่ที่ `asher-web/docs/quick-reply-spec.md`
(แนบ "หมายเหตุจากการสำรวจ" ท้ายไฟล์ — ★ สเปกเขียนก่อนเห็นโครงจริง ให้เชื่อหมายเหตุทับสเปกในจุดที่ชนกัน)

---

## 0. ทำก่อนอย่างอื่น

| ลำดับ | งาน | เหตุผล |
|---|---|---|
| 0.1 | **อ่าน handoff เจ้าของงานรูปก่อน**: `.handoff/media-pipeline-handoff.md` (+ คู่ `.handoff/HANDOFF-asher-connect-images-not-loading.md`, `docs/media-pipeline.md`) | งานท่อรูป (037) มี session เจ้าของและ handoff ของตัวเอง — โค้ดเขียนแล้วใน local **แต่ยังไม่ commit ไม่ apply ฐานใด ไม่ผ่านเทสต์ครบ** · อย่า commit/แก้งานของเขาแทน |
| 0.2 | **ประสานไฟล์ที่แย่งกัน 3 จุด**: `server.mjs` · `asher-web/src/components/ConversationActions.tsx` (งานรูปเพิ่งแตะ — TS ยังไม่เคย compile) · `asher-web/src/lib/inbox.ts` | QR ต้องแกะทั้ง 3 ไฟล์นี้เหมือนกัน — ถ้าทำขนานกันจะทับกัน · ทางที่ดี: รองานรูปถูก commit/ทดสอบเสร็จก่อน แล้ว QR เริ่มจาก state ล่าสุด |
| 0.3 | start docker compose ก่อนใด ๆ ที่ต้องใช้ฐาน (ตอนส่งมอบ **Docker Desktop ปิดอยู่**) · selftest งานรูป: `PGOPTIONS='-c asher.allow_db_tests=1' psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f sql/_selftest/037_media_pipeline_selftest.sql` · unit งานรูปผ่านแล้ว 9/9 (`npm run test:media`) | ทุกเทสต์ระดับ DB ต้องมี stack ขึ้นก่อน |
| 0.4 | asher-web: working tree มีงานจำนวนมาก uncommitted ทับ initial commit เดียว (`src/app/inbox`, `src/components`, `supabase/`, Dockerfile ฯลฯ) — **ถามเจ้าของก่อน** จะ commit ฐานเดิมเป็น commit แรกไหม | session นี้ยังไม่ได้ถามข้อนี้ |

ห้าม deploy อะไรขึ้นโปรดักชันเอง (โปรดักชัน = VPS `/opt/asher-inbox/app` + Supabase โปรดักชัน)
ทุกอย่างในเอกสารนี้ทำในเครื่องกับ stack ทดสอบ (`SUPABASE_URL=http://supabase-envoy:8000`, `CONNECT_SHADOW_MODE=true` ใน .env ของ asher-connect)

---

## 1. การตัดสินใจที่ผู้ใช้อนุมัติแล้ว (16 ก.ย. ~20:15)

| # | คำถาม (จากสเปก §13) | คำตอบ |
|---|---|---|
| 1 | เพจ Messenger เพจเดียวรับทั้ง Naii+Vibe หรือไม่ | **เพจเดียวรับทั้งคู่** → บอทต้องอนุมาน project (ดู design gap D1 — โมเดลข้อมูลปัจจุบันชนกับคำตอบนี้) |
| 2 | senior_sales แก้เทมเพลตได้ไหม | **ห้าม** — อ่าน/ใช้/บันทึก usage เท่านั้น (ตามสเปกเดิม) |
| 3 | Seed ฝั่ง Vibe (ยังไม่มีราคา/แปลนจริง) | **Placeholder + `active=false`** รอทีมการตลาดกรอกของจริงแล้วค่อยเปิด |
| 4 | งาน 037 ที่ค้าง uncommitted | **Commit แยกชัดเจน** ก่อนเริ่มงาน QR (ดู 0.1) |

---

## 2. เอกสารที่เก็บเข้า repo แล้ว (ใหม่ในวันนี้)

| ไฟล์ | คืออะไร |
|---|---|
| `D:\asher-stage\asher-web\docs\quick-reply-spec.md` | สเปกต้นฉบับจาก zip + หมายเหตุแก้ 5 จุดตามโครงจริง (หัวข้อ 3 ของเอกสารนี้) |
| `D:\asher-stage\asher-web\docs\quick-reply-manual.md` | คู่มือไทย แก้สถานะแล้วเป็น "ยังไม่เปิดใช้" (ต้นฉบับเขียนเหมือนระบบรันอยู่แล้ว — อย่าส่งให้ทีมก่อน implement เสร็จ) |
| `docs/handoff/2026-09-16-quick-reply.md` | เอกสารที่กำลังอ่านอยู่ |

---

## 3. ภาพจริงที่สเปกต้องปรับ (5 จุด — คัดจากผลสำรวจสอง repo)

### ★1 ไม่มี dispatcher `connect_api` ฝั่ง workspace — ออกแบบ RPC ใหม่ตามธรรมเนียมเดิม
- ฝั่ง asher-web/PostgREST: **ไม่มี** `connect_api(p_action,p_data)` ให้ต่อยอด — ธรรมเนียมคือ *ฟังก์ชัน SECURITY DEFINER แยกต่อ action* ใน schema inbox
  (ตัวอย่างเทียบ: `inbox.assign_conversation`, `inbox.add_canned_response`, `inbox.mark_read`, `inbox.agent_reply`)
  → ตั้งชื่อเป็น `inbox.qr_list / qr_suggest / qr_send / qr_upsert / qr_toggle / media_upload_url→media_upload_url ไม่ได้ ให้ใช้ snake_case ล้วน` เช่น `qr_list, qr_suggest, qr_send, qr_upsert, qr_toggle, media_upload_url→media_upload_url` — PostgREST เรียกชื่อ `qr.list` ไม่ได้ ใช้ `qr_list` ฯลฯ
- ทุกฟังก์ชันตามระเบียบที่ทำไว้: `REVOKE ALL … FROM public,anon` + `GRANT EXECUTE … TO authenticated[,service_role]` ต่อทันทีในไฟล์เดียว,
  ข้างในเช็กสิทธิ์ด้วย GUC `current_setting('role',true)` + `core.current_user_role()` (ดู agent_reply v3, `supabase/migrations/20260912000542_asher_rls_inbox_mutations.sql:121-134`)
- ฝั่ง asher-connect (บอท/ส่งของจริง): **อย่า re-emit `connect_private.api` ทั้งตัว** — มันถูกทับกันเองมาแล้ว 5 ไฟล์ (ตัวชนะปัจจุบัน `026`) และ `037` ตั้งใจไม่แตะ
  ให้ทำตามแนว 037: ฟังก์ชันแยก (`connect_private.quick_reply_*` หรืออ่านตารางตรง ๆ ด้วย service key) + `rpcDirect` ใน server.mjs
- โค้ด error ใหม่ต้องเพิ่มใน `safeCodes` (`server.mjs:105`) ไม่งั้นถูกยุบเป็น `request_rejected`

### ★2 `inbox.canned_response` มีอยู่จริงแล้วสองฝั่ง — ต้องตัดสินก่อนสร้างตารางใหม่
- schema: `reference/inbox-schema.sql:330-337` (shortcut/content/project_id/is_active, unique(project_id,shortcut)) + ฟังก์ชัน `add_canned_response`
- UI ปัจจุบัน: bootstrap ส่ง `canned` มาแล้ว (`026:49`) · asher-connect `public/app.js:368,538-552` และ asher-web `ConversationActions.tsx:67` ต่างเรนเดอร์เป็นปุ่ม flat
- แนะนำ: quick_reply **แทนที่** canned_response (migrate แถวเดิมเป็น seed ชุดแรก) แล้ว deprecate ปุ่มเก่าทั้งสอง UI — แต่เป็นการตัดสินใจที่ต้องยืนยันกับเจ้าของก่อน

### ★3 Storage กับ public URL ยังไม่มีจริง — `/media` ปัจจุบัน **ต้องล็อกอิน** (LINE ดึงไม่ได้)
- Supabase Storage: ยังไม่มีการใช้เลยทั้งระบบ (ไม่มี bucket, ไม่มี signed upload) — งาน 037 เพิ่งสร้าง bucket `inbox-media` แบบเข้าผ่าน server เท่านั้น
- `handleMedia` (`server.mjs:1087-1109`) บังคับ session + `safeMediaPath` (uuid/uuid.ext) → **LINE/Meta ที่มาดึง `originalContentUrl` จะโดน 401**
- สเปก §4 อยากได้ `public_url = https://inbox.apluscondo.com/media/<id>` แบบ public — ต้องออกแบบใหม่ เช่น (a) URL แบบมี token จำกัดเวลาที่ handleMedia ยอมรับโดยไม่ต้องล็อกอิน, หรือ (b) ปล่อยผ่าน Storage public bucket แยกสำหรับรูปเทมเพลต — **design gap D2**

### ★4 ท่อส่งจริงมีอยู่แล้วและรองรับรูป — ใช้ของเดิม อย่าสร้างทางเดินใหม่
- ประตูเดียว: insert `inbox.message` → trigger `inbox.enqueue_outbound` → `connect_private.delivery` → worker → `providers.deliver`
  (comment เด็ดขาดที่ `026:258`: "คิวขาออกเป็นของ trigger inbox.enqueue_outbound เท่านั้น")
- `renderPayload` (`providers.mjs:254-283`) **รองรับ `{type:'image', url, preview_url}` ทั้ง LINE (originalContentUrl/previewImageUrl) และ Messenger (attachment.url, is_reusable:true)** และ `quick_replies[]` (cap 13) อยู่แล้ว — มีเทสต์คลอ (`tests/providers.test.mjs:87-109`)
- **ไม่มี attachment_id cache** (`attachment_id` เจอ 0 ที่ใน repo) — สเปก §6 ต้องเขียนเอง (cache ใน `media_asset.fb_attachment_id` + invalidation ตอนเปลี่ยน page) — Messenger ปัจจุบันส่งรูปแบบ URL attachment ซึ่งโดน re-upload ทุกครั้งอยู่แล้ว
- ★ ข้อควรระวัง: `job.kind` มี CHECK constraint `('send','generate','notify','classify','typing')` (`sql/001:287-289`) — ถ้าจะเพิ่ม kind ใหม่ต้อง widen constraint ก่อน (หรืออย่าเพิ่ม)
- เทมเพลต 1 ชุด = หลาย message row (รูป N + ข้อความ 1) — insert ตามลำดับ ให้ trigger จัดคิวเอง (สอดคล้องสเปก §6 ที่เขียน "write outbound message rows" พหูพจน์อยู่แล้ว)

### ★5 กติกาบอทมีกลไกอยู่แล้วใน DB — อย่าสร้างขนาน และไม่ใช้ env switch
- ไม่มี `BOT_*` env เลยในระบบนี้ — สวิตช์อยู่ที่ `inbox.bot_config` (เช่น `bot.generate_enabled`, `send.live_enabled`)
  → สเปก §8 ขอ env `BOT_QUICK_REPLY_MODE=suggest|auto` ให้เปลี่ยนเป็น key ใน bot_config แทน (เช่น `qr.bot_mode`) และต่อปุ่มเข้า api `bot_switch`/`send_switch` แนวเดิม
- guardrails ที่สเปก §8 ขอ มีของเดิมครอบอยู่แล้ว: cooldown คนตอบ = `reply.human_hold_min` + `conversation.last_human_reply_at` (decide_reply `002:156-160`),
  quiet hours = `inbox.bot_schedule` ราย inbox + `inbox.bangkok_hour` (`002:69-89,162-175`) — ให้ QR bot อ่านกลไกเดิม อย่าเขียนเวลา/เงื่อนไขซ้ำ
- ทางเข้าของบอท: `receive_event` → `inbox.decide_all` → `bot_decisions` → คิว `generate` — สาขา QR ควรแทรกใน decide/worker ชั้นเดียวกัน พร้อมเขียน `bot_decisions` ตามธรรมเนียม
- ป้าย `bot_replied` ตามสเปก: `inbox.conversation` ไม่มีคอลัมน์ tags — มี `mode`, `bot_active`, `last_bot_reply_at` — ออกแบบใหม่ (คอลัมน์เพิ่ม หรือใช้ event)

---

## 4. Design gaps ที่ต้องตัดสินใจก่อนเขียนโค้ด

| # | ปัญหา | ทางเลือก |
|---|---|---|
| D1 | ผู้ใช้ตัดสิน "เพจเดียวรับทั้ง Naii+Vibe" แต่ project ผูกที่ `inbox.inbox.project_id` (1 inbox = 1 project, ใช้ทั้งบอทและ bootstrap `026:47` กรอง `code in ('asher-naii','asher-vibe')`) และ `inbox.conversation` **ไม่มี**คอลัมน์ project | (a) เพิ่ม `inbox.conversation.project_override` เซ็ตจาก ad/ref ตอนรับข้อความแรก + ถามผู้ใช้ถ้าไม่รู้ (b) เทมเพลตร่วม `project='all'` เท่านั้นที่บอทตอบบนเพจ shared จนกว่าจะรู้ project ที่แท้จริง |
| D2 | public URL รูปสำหรับ LINE/Meta (ดู ★3) | (a) token URL ผ่าน handleMedia (b) public bucket แยกสำหรับ quick-reply |
| D3 | quick_reply แทน canned_response หรืออยู่ร่วม (ดู ★2) | แนะนำแทนที่ + migrate แถวเดิม |
| D4 | สเปก §9 (stats hooks) เกาะกับชุด stats `016-019,027,028` ซึ่ง **ยังไม่เคยลงโปรดักชัน** (อ่าน `.handoff/stats-plan.md`) — ตัวชี้วัด "edit-before-send rate / ถามซ้ำใน 10 นาที" ต้องเขียนให้ไม่พึ่งชุดที่ยังไม่ลง หรือเลื่อนไปทำหลังลง stats ก่อน | เลื่อน §9 เป็นงานถัดจากการลง stats ชุดเดิม (แนะนำ) |

---

## 5. แผนงานที่เหลือ (ลำดับแนะนำ — ปรับจากสเปก §11 ตามโครงจริง)

0. ข้อ 0 ข้างบน (commit 037 · start docker · ตัดสินใจ D1-D4 กับเจ้าของ)
1. **Migration** — เลือกทาง: สเปกบอก "ใน asher-web" และฝั่งนั้นมีเครื่องมือครบ (`scripts/try-migration.sh` มี BEGIN/ROLLBACK dry-run, `mig:status`, `check:drift`, ledger `schema_migrations`, ชื่อไฟล์ `^\d{14}_`) ขณะที่ asher-connect มี track `sql/NNN` + `ORDER.txt` + ledger `inbox.sql_applied` ของตัวเอง
   → **แนะนำตามสเปก: ลง asher-web** (`supabase/migrations/<timestamp>_asher_quick_reply.sql`): 4 ตาราง + RLS ตามแบบ `canned_manage` + grant block ตามแบบ `20260912150000_asher_work_item.sql:89-102` + `alter table inbox.message add column if not exists quick_reply_id uuid` + ฟังก์ชัน `qr_*` ตาม ★1
   ★ ทุกตารางต้องมี policy ครบ ไม่งั้น `ops.rls_exception` / `npm run doctor` จะ flag (`20260912160000:14-46`)
   ★ อย่าลืม: ถ้าเขียน `core.event_log` มีคอลัมน์ NOT NULL ครบทุกฟิลด์ (project_id/channel/actor_type/request_id — เคยเจอที่ `20260912081500`)
2. **Media** — bucket + upload flow ฝั่ง asher-web (`media_upload_url/media_finalize` แบบ snake_case) + resolve D2 + ถ้าต้องแตะ asher-connect (`handleMedia` token mode) ให้แตะหลัง commit 037 แล้วเท่านั้น
3. **CRUD + seed** — หน้า `/settings/quick-replies` (หน้าแรกของระบบที่มี role-gating UI — เราเทียม role จาก RLS ได้เพราะไม่มีใครอ่าน core.profile ฝั่ง client มาก่อน) + ลงทะเบียนใน `src/lib/modules.ts` + seed script ตามแบบ `scripts/backfill-profiles.mjs` (dry-run default, service key, Vibe = placeholder `active=false`)
4. **qr_send** — ผ่าน insert `inbox.message` (ให้ trigger คิวเอง) ทั้งฝั่ง workspace (RPC) และบอท (`bot_reply` แนวเดิม) · เขียน `quick_reply_usage` + `edited_before_send` · cache `fb_attachment_id` (งานใหม่ล้วน ดู ★4)
5. **Composer UI** — `src/components/ConversationActions.tsx` คือไฟล์เดียวที่ต้องแตะ: แทน chips `canned` ด้วย `/` picker + แผงขวา + ชิป `qr_suggest` ใต้ข้อความลูกค้า · ธีม: chips ใช้ `var(--rule-soft)` (เทา), สีแดง = `var(--bad)` สงวนไว้เฉพาะ error/SLA ตามกติกาเดิม
6. **บอท suggest mode** — key `qr.bot_mode` ใน bot_config (ไม่ใช่ env), ใช้ guardrail เดิม (★5), เขียน `bot_decisions` ทุกครั้ง
7. เปิด `bot_enabled` รายเทมเพลตหลังมีข้อมูลชิป ~1 สัปดาห์ (การตัดสินใจของคน ไม่ใช่โค้ด)

เทสต์: asher-web ใช้ fixtures แบบ `supabase/tests/auth_roles_fixtures.sql` (BEGIN…ROLLBACK + `pg_temp.ck()`); asher-connect เพิ่ม `tests/quickreply.test.mjs` ใน chain `npm test` (injected fetcher ไม่แตะเน็ต) + selftest `sql/_selftest/038_…` ถ้ามี SQL ฝั่งนั้น · สไตล์ตาม `docs/testing.md`

---

## 6. บทบาท/RLS ที่ยืนยันแล้ว (ไม่ต้องเดาใหม่)

- role จริง = text check บน `core.profile.role`: `sales, senior_sales, marketing, manager, admin` (`20260911204622:10`) — บาง migration อ้าง 'finance' ที่ไม่มีใน check อย่าเลียนแบบ
- helper: `core.current_user_role()` / `core.current_user_team()` (`20260912000542:2-13`)
- สิทธิ์ตามสเปก §4: select+usage = `sales, senior_sales` (รวม insert `quick_reply_usage`), CRUD = `marketing, manager, admin` (senior_sales ห้าม — ผู้ใช้ยืนยันแล้ว)

## 7. Acceptance checks

ยกจากสเปก §12 คงเดิมทั้งหมด (LINE ได้รูปก่อนข้อความ · แก้ราคาแล้วทุกคน+บอทใช้ใหม่ทันที · FB ส่งซ้ำใช้ attachment_id เดิม · ชิปโผล่ <2 วิ · คนเพิ่งตอบ 30 นาที บอทเงียบ · quiet hours เงียบ · sales เข้า /settings/quick-replies ไม่ได้)
เพิ่ม: การส่งทุกทางต้องผ่าน trigger `enqueue_outbound` เท่านั้น · ถ้าเลือก migrate canned_response → ปุ่มเก่าทั้งสอง UI ต้องหายไปพร้อมกัน

## 8. ที่มา/วิธีตรวจซ้ำ

- สำรวจ read-only สอง repo เมื่อ 16 ก.ย. ~20:10-20:25 (agent สองตัว ครอบคลุม sql/, server.mjs, providers.mjs, bots/, tests/, migrations/, src/, scripts/)
- เลขบรรทัดทั้งหมดอ้างจาก working tree ณ เวลานั้น — ถ้ามี commit เพิ่ม ให้ re-grep ก่อนเชื่อ
- ตัวเลข "ยังไม่มี/ไม่เคย" (ไม่มี dispatcher, ไม่มี storage, stats ไม่เคยลงโปรดักชัน) ตรวจด้วย grep ครบ repo แล้ว · ถ้าจะเชื่อสเปกทับข้อสรุปนี้ ต้องหาหลักฐานใหม่ก่อน
