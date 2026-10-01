# หน้า "รายชื่อติดต่อ" + drawer ลูกค้า (2 ต.ค. 2569)

สถานะ: **โค้ด + SQL เสร็จ ทดสอบแล้ว · ยังไม่ deploy** · branch `claude/cool-turing-zcfief` ต่อจาก `16f0530` (production = `hotfix/login-button-color`)

## ยืนยัน repo ก่อนเริ่ม (ข้อ 0 ของสเปก)
`akecruise/asherconnect` สาย `hotfix/login-button-color` คือ production จริง — VPS รายงาน `.deployed-commit = 933d47b` ซึ่งอยู่ในสายนี้
และ `scripts/deploy-from-github.sh` เทียบไฟล์บน VPS กับ commit ก่อนวางทับทุกครั้ง

## ได้อะไร
| ส่วน | รายละเอียด |
|---|---|
| `sql/202610021000_contacts_page.sql` | `inbox.contacts_list` · `inbox.contact_detail` + ตัวช่วย 3 ตัว (ไม่เปิดให้หน้าเว็บ) · **อ่านอย่างเดียว ไม่มีตาราง ไม่เขียนข้อมูล ไม่แตะเวลาข้อความ** (มีเทสต์ static กันไว้) |
| `/contacts` | ตาราง: เลือก · โปรไฟล์ (รูป+ชื่อ+ป้ายช่องทาง+★) · แท็ก · ระยะ · ผู้รับผิดชอบ · เบอร์ (mask) · แชทล่าสุด+ป้าย SLA · เปิดแชท / รายละเอียด |
| ค้นหา/ฟิลเตอร์/เรียง | ชื่อ/เบอร์ · แท็ก · ระยะ · ผู้รับผิดชอบ (รวม "ยังไม่มีคนรับ") · ช่องทาง · SLA · ติดดาว · แชทล่าสุดก่อน/เก่าสุดก่อน — กรองที่ฐานทั้งหมด |
| ทำหลายแถว | ติดแท็ก (`case_tags_set` ทีละราย) · มอบหมาย (คำสั่ง `transfer` เดิมของ connect_api ทีละเคส มี audit/request_id/emit CRM ตามเดิม · manager/admin/senior_sales) · สรุปผลตามจริงรวมสาเหตุที่พลาด |
| drawer ลูกค้า | ตัวเดียวใช้สองที่: แผงขวาหน้าแชท (บนสุด เหนือฟอร์มแก้ข้อมูล) และ drawer หน้ารายชื่อ — รูป/ชื่อ/ช่องทาง/ดาว · ระยะ · SLA · ผู้รับผิดชอบ · เบอร์ · ติดตาม · แท็ก (+ แก้ได้) · ประวัติการคุยทุกช่องทางพร้อมปุ่มเปิดแชท |
| เมนู | ปุ่ม "รายชื่อติดต่อ" ในแถบเมนูเปิดใช้แล้ว · "เปิดแชท" ไปที่ `/?open=<id>` (production ไม่มี route `/conversations/<id>`) |

## กฎเหล็ก — ทำอย่างไร
- **ไม่แก้วันที่ข้อความ**: migration ไม่มี update/insert/alter บน `inbox.message` และไม่มี `created_at =` — `tests/case-flags.test.mjs` ตรวจไฟล์ให้
- **ไม่ infer ว่าพนักงานตอบแล้ว**: ป้าย SLA มาจาก `inbox.case_status` เดิม (นับจากข้อความลูกค้าจริงเทียบคำตอบที่ส่งถึงจริง) ฐานแปลงเป็น over/near/ok · ใกล้เกิน = ครึ่งหนึ่งของ `sla_minutes` ตรงกับ `public/sla.mjs`
- **ระยะ** คิดจากหลักฐาน: `crm.stage` ของ lead ล่าสุด + มีคำตอบจากคนแล้วหรือยัง (`last_human_reply_at` / `first_human_response_at`) — ไม่มีป้ายให้คนตั้งเอง
- **verify ก่อน merge**: Playwright ยิงผ่าน `node server.mjs` ตัวจริง (หน้า `/contacts` และ `case-flags.mjs` เสิร์ฟผ่าน `staticFiles` จริง) · `tests/static-files.test.mjs` ผ่าน

## ทดสอบแล้ว
- DB (Postgres 16 จำลอง schema ขั้นต่ำ — **ยังไม่ได้รันกับ supabase จริง**): `tests/contacts-page.db.test.mjs` — แถวละลูกค้า, ชี้เคสล่าสุด, mask เบอร์ sales/เต็ม manager, ระยะ ใหม่/จอง, SLA เกิน/ใกล้/ปกติจากข้อความจริง, ฟิลเตอร์ทุกตัว, เรียงสองทาง, reviewer เห็นแค่แชททดสอบ, คนนอกเข้าไม่ได้, เวลาข้อความไม่เปลี่ยน · ลองตัด `can_read` ออกแล้วเทสต์จับได้ · **จับบั๊กจริงได้ 1 ตัว**: ไม่ส่ง `sort` แล้วรายการไม่เรียง (แก้แล้ว)
- รันเทสต์ DB ต้องใช้ `--test-concurrency=1` (สองไฟล์ลง migration พร้อมกันจะ deadlock) — ตั้งไว้ใน `npm run test:star-follow-tags`
- Playwright 1440px + 390px: ทุกขั้นผ่าน ไม่มี JS error · ไม่มีคำสั่งส่งข้อความใดถูกเรียก

## ★ ยังไม่ได้ทำ — ต้องขอข้อมูลเพิ่ม (ไม่เดา)
1. **ส่ง narrowcast (LINE)** — ปุ่มมีแล้วแต่เปิดหน้าจออธิบายอย่างเดียว **ยังไม่ส่งอะไรออกไป** ต้องรู้ก่อน:
   - ข้อมูล consent ของลูกค้าเก็บที่ไหน (ตอนนี้ฐานไม่มีช่องนี้)
   - role ไหนส่งได้ และเพดานต่อครั้ง/ต่อวัน
   - ใช้ LINE OA ช่องไหน (Naii / Vibe) และโควตาข้อความของแพ็กเกจ
   - log ที่ต้องการ: เก็บที่ `connect_private.audit` พอไหม หรือต้องตารางแยก
2. **ใครเห็นเบอร์เต็ม** — ตอนนี้ manager/admin เห็นเต็ม · sales/senior_sales/reviewer เห็น `***-***-1234` (เลือกแบบแคบสุดไว้ก่อน แก้ที่ `inbox.contact_phone_out` ที่เดียว) · ฟอร์มแก้ข้อมูลในหน้าแชทยังแสดงเบอร์เต็มให้เจ้าของเคสเหมือนเดิม
3. **มอบหมายเคสที่ยังไม่มีคนรับ** — คำสั่ง `transfer` เดิมของฐานปฏิเสธ (`claim_required`) หน้าจอรายงานตามจริง ถ้าต้องการให้ manager มอบเคสใหม่ได้เลย ต้องเพิ่มฟังก์ชันใหม่ในฐาน (ไม่แตะ `connect_private.api`) — รอยืนยัน
4. **Sidebar ซ่อนได้ + เมนูส่งข้อความหลายคน/ตั้งค่าแชท** — อยู่ในใบงาน `docs/specs/2026-10-02-sidebar-nav.md` รอบนี้แค่เปิดปุ่ม "รายชื่อติดต่อ" ในเมนูเดิม
5. ภาพ LINE OA ที่อ้างในสเปกไม่ได้แนบมาถึง — ทำตามคอลัมน์/ฟิลเตอร์ในข้อความแทน

## Deploy
มี SQL 1 ไฟล์ (อ่านอย่างเดียว) — สคริปต์ backup schema `connect_private` + `inbox` ให้ก่อนลง
```bash
curl -fsSL https://raw.githubusercontent.com/akecruise/asherconnect/<commit>/scripts/deploy-from-github.sh -o /tmp/deploy.sh
EXPECT_LIVE=$(cat /opt/asher-inbox/app/.deployed-commit) bash /tmp/deploy.sh <commit> sql/202610021000_contacts_page.sql
```
หลัง deploy ถ้าหน้า /contacts ขึ้น "โหลดรายชื่อไม่สำเร็จ" ให้รัน `docker exec supabase-db psql -U postgres -d postgres -c "notify pgrst, 'reload schema'"` (PostgREST ยังไม่เห็นฟังก์ชันใหม่) หรือ `bash scripts/post-deploy-check.sh case-flags contacts_list`
