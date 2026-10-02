# Handoff — ASHER Connect: ดาว/Tag · รายชื่อติดต่อ · drawer · เมนูแบบ LINE OA (1–2 ต.ค. 2569)

## สถานะตอนส่งมอบ
| | |
|---|---|
| Production (VPS `/opt/asher-inbox/app`) | **`4a5482dbc9d44ce12df7c2c92952cf995736abbd`** — deploy ผ่าน 2026-10-01 16:55 UTC (`/`, `/app.js`, `/app-nav.js`, `/case-flags.mjs`, `/contacts` = 200) |
| Branch งาน | `claude/cool-turing-zcfief` (ไฟล์นี้อยู่ commit ถัดจาก `4a5482d` — เอกสารล้วน ไม่ต้อง deploy) |
| Branch production ใน repo | `hotfix/login-button-color` = `16f0530` — **ยังตามหลัง VPS** (ยังไม่ merge งานตั้งแต่ `f52bab0`) |
| PR | [akecruise/asherconnect#1](https://github.com/akecruise/asherconnect/pull/1) merged แล้ว (ดาว/ติดตาม/Tag รอบแรก) · งานหลังจากนั้นยังไม่มี PR |
| SQL ที่ลง production แล้ว | `202610011000_contact_star_tags.sql` · `202610021000_contacts_page.sql` (อ่านอย่างเดียว) |

★ **production จริงคือสาย `hotfix/login-button-color`** ไม่ใช่ `fe29fea`/`connect-profile-content`/`master`/`main` — `20a7799` คือ snapshot ของ VPS ที่แก้มือจนแยกสายไปแล้ว

## งานที่ขึ้น production แล้ว
1. **ดาว · การติดตาม · Tag แบบ LINE OA** — `docs/handoff/2026-10-01-star-follow-tags.md` (ท้ายไฟล์มีผลการลงมือ)
   ดาว SVG ขนาด Facebook · popover แท็ก · หน้าจัดการแท็กแบบ LINE OA (ค้นหา/สร้าง/แก้/ลบ, สี 7 สี)
2. **หน้ารายชื่อติดต่อ `/contacts` + drawer ลูกค้า** — `docs/handoff/2026-10-02-contacts-page.md`
   แถวละลูกค้ารวมทุกช่องทาง · ค้นหา/ฟิลเตอร์/เรียงที่ฐาน · ติดแท็ก/มอบหมายทีละหลายแถว · drawer ใช้ร่วมกับแผงขวาหน้าแชท
3. **เมนูแบบ LINE OA**
   - จอ ≥768: แถบซ้าย แชท · รายชื่อติดต่อ · ส่งข้อความหลายคน (ปิด) · สถิติ · จัดการแท็ก · ตั้งค่า · **ซ่อนเมนู** (ยุบ 64px จำใน `localStorage` `connect.nav.collapsed`; `public/app-nav.js` ตั้งสถานะก่อนวาด กันกะพริบ)
   - มือถือ: ปุ่ม "เมนู" เปิดหน้าหลักแบบไทล์ (ตั้งค่าอยู่ในนั้น) — แถบบนเหลือ แชท · รายชื่อติดต่อ · เมนู · รีเฟรช
   - ★ หน้า `/stats` `/logs` `/quick-replies` **ยังไม่มีแถบซ้าย** — ดูใบงาน `docs/specs/2026-10-02-sidebar-nav.md` (ส่วนที่ยังขาด: ใช้แถบเดียวกันทุกหน้า, ตั้งค่า SLA, flyout เมนูย่อย)

## วิธี deploy (ใช้มาแล้วหลายรอบ — ทำงานได้)
รันบน VPS ตรง ๆ (**ไม่ต้อง ssh** — ssh เข้าตัวเองจะ Permission denied):
```bash
curl -fsSL https://raw.githubusercontent.com/akecruise/asherconnect/<COMMIT>/scripts/deploy-from-github.sh -o /tmp/deploy.sh
DRY_RUN=1 EXPECT_LIVE=$(cat /opt/asher-inbox/app/.deployed-commit) bash /tmp/deploy.sh <COMMIT> [sql/ไฟล์.sql]   # ดูแผน
EXPECT_LIVE=$(cat /opt/asher-inbox/app/.deployed-commit) bash /tmp/deploy.sh <COMMIT> [sql/ไฟล์.sql] 2>&1 | grep -v "^ *=> \|^#[0-9]" | tail -25
docker exec supabase-db psql -U postgres -d postgres -c "notify pgrst, 'reload schema'"   # ถ้ามี SQL ใหม่
```
สคริปต์: ตรวจ `.deployed-commit` → เทียบไฟล์บนเครื่องกับ commit (แก้มือ: ไฟล์โค้ดรวม 3 ทางด้วย `diff3 -m -E`, `sql/ docs/ tests/` เก็บของบนเครื่อง, ชนกันจริงหยุด) → tag image `rollback-*` + สำเนาโฟลเดอร์ + `pg_dump` → ลง SQL → แตกโค้ด → build → ตรวจ 200
ตรวจหลัง deploy ไม่เห็นผล: `bash scripts/post-deploy-check.sh case-flags contacts_list`

## กับดักที่เจอแล้ว (อย่าพลาดซ้ำ)
- **`server.mjs` เสิร์ฟเฉพาะไฟล์ใน `staticFiles`** — ไฟล์ใหม่ใน `public/` ต้องลงตาราง ไม่งั้น 404 และถ้าเป็น import ของ `app.js` หน้าแชทพังทั้งหน้า · `tests/static-files.test.mjs` จับให้ · เทสต์ Playwright ต้องยิง `node server.mjs` ตัวจริง ไม่ใช่ stub ที่เสิร์ฟทุกไฟล์
- **CSP ห้าม inline script/style**
- **บน VPS มีของที่ไม่อยู่ใน repo:** `sql/202609301000_phone_signal_to_crm.sql`, `sql/phone_signal_selftest.sql` และ `sql/ORDER.txt` ฉบับ VPS (สคริปต์ deploy เก็บไว้ให้) — **ควร commit จากเครื่องผู้ใช้**
- `app.css` ให้กฎท้ายไฟล์ชนะโดยตั้งใจ · สีต้องเป็นตัวแปรใน `:root` (สว่าง+มืด) · แดงแบรนด์สงวนให้ SLA
- production ไม่มี route `/conversations/<id>` — เปิดเคสจากที่อื่นใช้ `/?open=<uuid>`
- เทสต์ DB สองไฟล์ต้องรัน `--test-concurrency=1` (ลง migration พร้อมกันแล้ว deadlock)
- cloud session นี้เข้า VPS/โดเมนไม่ได้ (network policy) — ผู้ใช้เป็นคนรันบน VPS แล้ววางผลกลับมา

## ค้าง — ต้องให้ผู้ใช้ตัดสิน/ส่งข้อมูล
| # | เรื่อง | ต้องการอะไร |
|---|---|---|
| 1 | merge งาน `f52bab0..4a5482d` (+ไฟล์นี้) เข้า `hotfix/login-button-color` | เปิด PR → merge แบบ merge commit (ให้ `4a5482d` อยู่ในประวัติ) |
| 2 | **narrowcast LINE** (ปุ่มมีแต่ไม่ส่งอะไร) | แหล่ง consent · role ที่ส่งได้ + เพดาน · ใช้ OA ไหน (Naii/Vibe) · log ที่ต้องการ · ★ โควตา: OA @wdq0911k รีช 2,690 แต่ฟรี 300/เดือน → ต้องมีหน้ายืนยันจำนวนข้อความเทียบโควตาคงเหลือ |
| 3 | ใครเห็นเบอร์เต็ม | ตอนนี้ manager/admin (แก้ที่ `inbox.contact_phone_out`) |
| 4 | มอบหมายเคสที่ยังไม่มีคนรับ | `transfer` เดิมปฏิเสธ (`claim_required`) — ถ้าต้องการต้องเพิ่มฟังก์ชันใหม่ (ไม่แตะ `connect_private.api`) |
| 5 | error `schema_version_latest` (`202609172025` เกิน integer) ทุก 5 นาที | ผล `pg_get_functiondef('inbox.schema_version_latest()'::regprocedure)` — ฟังก์ชันนี้ไม่อยู่ใน repo |
| 6 | คำตอบ 4 ข้อของสเปกดาว/Tag | ตอนนี้ใช้ค่าที่เสนอ (sales สร้างแท็กได้ · ดาวของทีม · ยังไม่ sync CRM · tag เริ่มต้น 7 อัน) |
| 7 | เฟส 2 | เตือน Telegram เมื่อถึงเวลาติดตาม (เว้น 00:00–06:00) · นับดาว/tag ใน `queue_counts` |
| 8 | token ช่อง `asher-instagram` หมดอายุ (log `channel_token_invalid` 401) | ต่ออายุ token ใน `channels.json` บน VPS |
| 9 | ผู้ใช้พิมพ์ "แปล" — ยังไม่รู้ว่าให้แปลอะไร | ถามว่าหมายถึงคำอังกฤษบนจอ (Tag ▾, Hot, SLA) หรืออย่างอื่น |

## ไฟล์อ้างอิง
- `docs/handoff/2026-10-01-star-follow-tags.md` · `docs/handoff/2026-10-02-contacts-page.md` · `docs/specs/2026-10-02-sidebar-nav.md`
- `scripts/deploy-from-github.sh` · `scripts/post-deploy-check.sh`
- SQL: `sql/202610011000_contact_star_tags.sql` · `sql/202610021000_contacts_page.sql`
- เทสต์: `tests/case-flags*.test.mjs` · `tests/static-files.test.mjs` · `tests/star-follow-tags.db.test.mjs` · `tests/contacts-page.db.test.mjs` (`ALLOW_DB_TESTS=1`, `DB_TEST_URL=` ได้)
