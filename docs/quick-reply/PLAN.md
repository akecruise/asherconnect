# Quick Reply + คลังรูป — PLAN (เฟส 0: ผลสำรวจ)

สถานะ: **รออนุมัติ** · สำรวจ 2026-09-26 · branch `feature/quick-reply-image-library` (worktree `D:\aplus_postgres_docker\asher-connect-qr-image-library`, แตกจาก `9904175`)

## สรุปสั้น

brief เดิมเขียนเหมือนเริ่มจากศูนย์ แต่ของจริงมีอยู่แล้วราว 70% และ **ขึ้น production แล้ว**
(Quick Replies 17 ก.ย. + ชุดรูป Naii 25 ก.ย.) → เสนอ **ต่อยอดตารางเดิม ไม่สร้าง `inbox.quick_replies` / `inbox.media_assets` ใหม่**
ของที่ขาดจริงคือ "คลังรูป" แบบเลือกรูปเดี่ยว, metadata ของรูป (หมวด/หมดอายุ/บอท), ป้าย "ส่งแล้ว", และ URL สาธารณะที่ LINE ดึงได้โดยไม่ต้องอัปโหลดซ้ำ

## 1. ของที่มีอยู่แล้ว

### ฐานข้อมูล (schema `inbox`, อ้าง `docs/answer-hub/AUDIT.md` + `sql/038` ใน `~/asher-quick-replies-complete`)
| ตาราง | คอลัมน์หลัก | เทียบกับ brief |
|---|---|---|
| `quick_reply` | project (naii\|vibe\|all), category (ชุดปิด 8 อังกฤษ + ไทย), shortcut unique(project,shortcut), title, body, send_order, intents[], bot_enabled, confidence_min, sort_order, active, created_by/updated_by, source/source_shortcut | = `inbox.quick_replies` (ครบกว่า) |
| `quick_reply_attachment` | PK(quick_reply_id, position), media_asset_id | = `quick_reply_media` |
| `media_asset` | project, title, storage_path unique, mime, width, height, bytes, active | = `media_assets` แต่ **ขาด** category, bot_enabled, expires_at, preview_path, use_count |
| `quick_reply_usage` | quick_reply_id, conversation_id, message_id, sent_by, partial, matched_intent … | นับ QR ได้ แต่ **ไม่มีระดับรูป** → ไม่มี `media_sends` |

RPC ที่มี: `qr_list`, `qr_list_all`, `qr_use`, `qr_upsert` (รับ attachments), `qr_toggle`, `qr_import_apply`
— เป็น **ฟังก์ชัน SECURITY DEFINER แยกต่อ action** ไม่ได้ผ่าน `connect_private.api` อยู่แล้ว (ตรงกับข้อห้ามใน brief)

ข้อมูลบน prod: รูป Naii 25 รูปใน bucket `inbox-media` (private), QR ชุดรูป 9 ตัว (`NAII_PHOTO_*`, ≤4 รูป, bot_enabled=false) + QR ข้อความ 12 ตัว

### การเก็บรูป
- Supabase Storage self-hosted, bucket `inbox-media` **private** (สร้างใน 037) — ไม่มี public bucket
- เสิร์ฟให้เซลส์ผ่าน `/quick-reply-media/<path>` (`lib/quick-reply-media.mjs`) ต้องมี session + ตรวจว่ารูปผูกกับ QR ที่ active

### การส่งรูปออก (`providers.mjs` `renderPayload`)
- LINE: `{type:'image', originalContentUrl, previewImageUrl}` ✔
- Messenger: `attachment.type=image` + `is_reusable:true` ✔ แต่ **ไม่เก็บ attachment_id** → อัปโหลดซ้ำทุกครั้ง
- Instagram: 1 รูป/ครั้ง และห้ามรูป+ข้อความพร้อมกัน (บังคับใน app.js)
- ส่งรูปจาก composer: browser แปลงไฟล์เป็น base64 → `validateOutboundImages` (`lib/outbound-media.mjs`: JPEG/PNG/WEBP, ≤10MB, ≤5 รูป, ปฏิเสธ HEIC) → อัปโหลดเข้า `inbox-media` → ทำ URL ให้ provider
  - prod (snapshot 25 ก.ย.): `signMediaObject` = Supabase signed URL
  - working copy หลัก (**ยังไม่ commit, งานของ session อื่น**): เปลี่ยนเป็น `lib/media-public.mjs` HMAC URL `/media/public/<path>?expires&token` (TTL 1 ชม.)
- คิวขาออกมีเจ้าของเดียวคือ trigger `inbox.enqueue_outbound` — ห้ามใส่ `connect_private.delivery` เอง

### UI composer
- `public/quick-replies.js`: popover แท็บเดียว มีค้นหา, ชิปหมวด, เรียง ใช้บ่อย/ล่าสุด/A–Z, thumbnail, เปิดด้วย `/` ตอนช่องว่าง
- `public/app.js` `asherApplyQuickReplyMedia`: กด QR ที่มีรูป → ดึงรูปมาเป็น File → ใส่ถาดแนบ (`image-preview`) + ข้อความ → เซลส์ตรวจแล้วกดส่งเอง (ไม่ auto-send)
- ถาดแนบ + ปุ่มลบทีละรูป + ปุ่มแนบไฟล์ มีแล้ว
- หน้า admin `/quick-replies` (quick-replies-admin.*) จัดการ QR + แนบรูป

## 2. ช่องว่างเทียบกับ brief

| # | brief ต้องการ | สถานะ |
|---|---|---|
| G1 | แท็บ "คลังรูป" เลือกรูปเดี่ยวหลายรูป + เลขลำดับ | ไม่มี (มีแต่รูปที่ผูกกับ QR) |
| G2 | หมวดรูป / หมดอายุ / bot_enabled / use_count ต่อรูป | ไม่มีคอลัมน์ |
| G3 | ป้าย "ส่งแล้ว" ต่อลูกค้า | ไม่มีข้อมูลระดับรูป |
| G4 | ส่งรูปจากคลังโดยไม่อัปโหลดซ้ำ | ตอนนี้ดึงรูป→อัปโหลดใหม่ทุกครั้ง (ทำงานได้ แต่ไฟล์ซ้ำใน storage) |
| G5 | Messenger attachment_id cache | ไม่มี |
| G6 | ปุ่ม "+ เพิ่มรูปเข้าคลัง" ในป๊อปโอเวอร์ | ไม่มี (มีแต่ในหน้า admin QR) |
| G7 | เลือก QR แล้ว "แก้ไขได้ก่อนส่ง" | มีแล้ว ✔ |
| G8 | ส่งรูปนับเป็นการตอบใน SLA | ต้องตรวจในเฟส 2 (ส่งรูปล้วนผ่าน path เดียวกับข้อความ น่าจะนับ แต่ยังไม่ได้พิสูจน์) |
| G9 | แปลง WEBP→JPEG, สร้าง thumbnail | ไม่มี และ **lib ตั้งใจ zero-dependency** (ไม่มี sharp) → ดูข้อเสนอ D3 |

## 3. ข้อเสนอ (ต้องตัดสินใจก่อนเฟส 1)

**D1 — ตาราง:** ALTER ของเดิมแบบเพิ่มเท่านั้น
- `media_asset` + `category text` (ชุดปิด room/plan/facility/location/promo/other), `bot_enabled bool default false`, `expires_at timestamptz`, `preview_path text`, `created_by uuid`, `archived_at` (ใช้คู่กับ `active` เดิม)
- ตารางใหม่ `inbox.media_asset_send(media_asset_id, conversation_id, message_id, sent_by, sent_at)` → ได้ทั้งป้าย "ส่งแล้ว" และ use_count (นับจาก view ไม่เก็บตัวเลขซ้ำ)
- `media_asset_channel_cache(media_asset_id, channel_key, attachment_id, cached_at)` สำหรับ Messenger (แยกตาม page เพราะ attachment_id ผูกกับ page)
- RPC แยกฟังก์ชัน: `media_list`, `media_create`, `media_update`, `media_archive` (ไม่แตะ `connect_private.api`)
- ⚠ AUDIT ADR-005 บันทึกว่า `inbox.quick_reply*` เดิมเป็นของ asher-web — การ ALTER `media_asset` จาก asher-connect ต้องยืนยันว่าไม่มี migration ฝั่ง asher-web ที่จะทับ

**D2 — ที่เก็บรูป / URL สาธารณะ:** ใช้ bucket `inbox-media` เดิม + HMAC URL ของ `lib/media-public.mjs` (ที่ session อื่นเขียนไว้)
- ข้อดี: ไม่ต้องเปิด public bucket, URL หมดอายุเองได้, LINE ดึงได้ผ่าน inbox.apluscondo.com/Caddy
- เงื่อนไข: ต้องรอ/รวมงานนั้น commit ก่อน (ตอนนี้ยังค้างใน working copy หลัก) — ห้ามคัดลอกไปทำซ้ำ
- ทางเลือกที่ไม่แนะนำ: โฟลเดอร์ที่ Caddy เสิร์ฟตรง (หลุดจากการตรวจสิทธิ์ + backup แยก)

**D3 — thumbnail/WEBP:** ไม่เพิ่ม dependency ใน image
- อัปโหลดผ่านหน้าเว็บ: ให้ browser ย่อรูป + แปลง WEBP→JPEG ด้วย canvas ก่อนส่ง (ได้ทั้งตัวจริงและ preview)
- server ตรวจ magic bytes + ขนาดเหมือน `validateOutboundImages` เดิม
- ตัวเลขลิมิตยึดเอกสารทางการตอนเฟส 2 (LINE: original/preview ต้อง HTTPS, JPEG/PNG; Messenger/IG ตรวจค่าปัจจุบัน)

**D4 — สิทธิ์อัปโหลด:** เสนอให้ **sales อัปโหลดได้แต่รูปเข้าสถานะ "รอตรวจ"** (ไม่โผล่ในคลังจนกว่า marketing/manager/admin อนุมัติ) — หรือถ้าอยากเรียบง่าย ตาม brief: เฉพาะ marketing/manager/admin
reviewer (test_only) เห็นเฉพาะรูปตัวอย่าง ไม่เห็นปุ่มเพิ่ม

**D5 — base ของ branch:** โค้ด naii-media ที่ขึ้น prod 25 ก.ย. (server.mjs, app.js, quick-replies.js, lib/quick-reply-media.mjs) **ยังไม่ได้ commit ที่ใดเลย** — อยู่ใน worktree `asher-connect-naii-media-20260925` ที่ Windows git อ่านไม่ได้ (ลงทะเบียนด้วย path `/mnt/d` ของ WSL)
→ ก่อนเฟส 1 ต้อง commit ชุดนั้นเข้า branch นี้ก่อน ไม่งั้นงานใหม่จะทับของที่อยู่บน prod ตอน deploy

**D6 — ความสัมพันธ์กับ Answer Hub:** HANDOFF ระบุตัวถัดไปคือ Phase 7 "QR Integration" — งานนี้ควรนับเป็น Phase 7 (หรือส่วนหนึ่ง) เพื่อไม่ให้มีสองแผนคู่ขนาน · ฝั่งบอทยังไม่ทำตาม brief แต่ใส่ `bot_enabled` ไว้ให้พร้อม

## 4. ลำดับงานหลังอนุมัติ

1. commit ชุด naii-media (D5) + รวมงาน media-public (D2) เข้า branch
2. เฟส 1: `sql/<timestamp>_media_library.sql` (ALTER + ตารางใหม่ + RPC) + selftest `sql/_selftest/` + วิธีรันมือในหัวไฟล์
3. เฟส 2: endpoint อัปโหลดคลัง, ส่งรูปจากคลังโดยอ้าง `media_asset` ตรง (ไม่ดาวน์โหลด-อัปโหลดซ้ำ), cache Messenger, บันทึก `media_asset_send`, พิสูจน์ SLA
4. เฟส 3: เพิ่มแท็บ "คลังรูป" ใน popover เดิม (`quick-replies.js`) + Esc เฉพาะตอนโฟกัส + ป้ายส่งแล้ว + ฟอร์มเพิ่มรูป
5. เฟส 4: ทดสอบกับแชต is_test ทั้ง LINE และ Messenger + TEST-CHECKLIST.md + DEPLOY.md (tar ต้องมี `lib/`)
