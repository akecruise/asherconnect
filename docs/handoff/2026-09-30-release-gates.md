# Handoff — พัก 30 ก.ย. 2569 / ทำต่อ 1 ต.ค. 2569

ผู้ใช้สั่งหยุดงานและทำ handoff เพื่อทำต่อพรุ่งนี้ ไม่ใช่ให้ทำต่อเบื้องหลัง
**ยังไม่ได้ merge/deploy การแก้ gate และยังไม่ได้เขียน regression tests ใหม่ในรอบนี้**
ตรวจ/อ่านโค้ดและรัน baseline แล้วเท่านั้น งาน import production ก่อนหน้านี้แยกจากงาน gate

## ขอบเขตที่ยืนยัน

- บัญชี/โครงการ: Asher Condo ทั้งหมดเป็น ASHER Naii (อินทามระ 41)
- Connect และ CRM เป็นคนละระบบ: รายชื่อเข้า CRM ไม่สร้างแชท Connect
- ใช้ synthetic data + isolated DB ในการทดสอบ ห้ามใช้ production เป็น sandbox
- ผู้ใช้ยืนยันให้แก้ตาม gates และยืนยัน seams ผ่านคำสั่ง “แก้” หลังคำถาม TDD
- **บั๊กใหม่ → เพิ่ม gate → เทสต์แดง → แก้ขั้นต่ำ → เทสต์เขียว** ทีละ vertical slice
- ห้ามเปลี่ยน historical timestamps เป็นปัจจุบันเพื่อดันแชทขึ้นบน
- ไม่เดาชื่อ ไม่สร้าง PSID/IGSID/LINE userId จากชื่อ/เบอร์/LINE handle/UI thread ID

## Repositories / worktree

Connect: `/mnt/d/aplus_postgres_docker/asher-connect`
HEAD: `fe29feabef609e46ba61ff11838dd7111415cf3b`

CRM: `/mnt/d/aplus_postgres_docker/asher-crm`
HEAD: `1461a155331a9b305b14d27e7cf8481f8c551ee9`

ทั้งสอง worktree มีงานค้าง ห้าม reset/checkout ทับ และห้าม deploy dirty tree
Connect modified: `lib/customer-contact-extraction.mjs`, `lib/profile.mjs`,
`package.json`, `providers.mjs`, `scripts/backfill-profiles.mjs`, `server.mjs`,
`sql/ORDER.txt`, `tests/customer-contact-extraction.test.mjs`, `tests/profile.test.mjs`.
Untracked สำคัญ: contact-contract migration/tests/fixtures, diagnostic scripts,
`scripts/backfill-instagram-history.mjs` และเอกสารประกอบ ดู `git status` ใหม่ก่อนทำงาน
CRM: import scripts/tests และ `docs/contact-list-2026-import.md` ยัง untracked
ไม่อนุมานว่าไฟล์ทั้งหมดเป็นงานที่จะ deploy ใน gate รอบนี้

## Gates ที่ต้องทำก่อน merge/deploy

| Gate | เงื่อนไข | สถานะที่ตรวจได้ |
|---|---|---|
| A Phone pipeline | Connect receive SQL → durable event → CRM ConnectProfileFields → customer read API; tracer เบอร์เดียวตลอดทาง | Connect มี isolated tests บางส่วนแล้ว; CRM contract ยังไม่รับ phone |
| B Identity | ไม่เดาชื่อ, identity มี account/page scope, provenance, ไม่ทับ manual data | ต้อง audit coverage; ห้ามตีความหนึ่ง profile เป็น permission ให้ auto-merge จากชื่อ |
| C SLA | หยุดเฉพาะ send success / echo / คนยืนยัน; แยก bot/human; indirect signal ห้ามหยุด | C1–C4 ยังไม่ได้ตรวจ coverage/เขียนเพิ่ม |
| D Inbox | manual refresh กลับหน้า 1; เรียงวันที่คุยจริง; search ทุกหน้า | พบ refresh ไม่ reset offset; D1–D4 ยังไม่เพิ่ม tests |
| E Errors | unknown upstream errors ไม่ถูกกลบเป็น request_rejected; ไม่ leak secret/internal detail | พบ fallback จริงใน server.mjs; E1 ยังไม่แก้ |
| F Release | typecheck/tests, module-import-ok, backup+checksum, ledger จากสิ่งที่รันจริง | baseline ผ่านบางคำสั่งเท่านั้น; ไม่มี release approval evidence ครบ |

ไม่มีไฟล์ต้นฉบับที่นิยามเลข A1–A3/C1–C4/D1–D4/E1 แบบละเอียดจากผู้ใช้
ต้องระบุ test-to-gate mapping ตามพฤติกรรมที่ให้ ไม่แต่งข้อกำหนดธุรกิจเพิ่มเอง

### Seams ที่ตกลงใช้

- A/B: receive-event → event ingestion → public CRM customer read API
- C: send outcome / echo / explicit human acknowledgement → SLA state API
- D: หน้า Inbox จริง (DOM interaction), ไม่ใช่ regex จับ source แล้วอ้างว่า browser test
- E: HTTP request/response ของ Connect; mock เฉพาะ upstream boundary
- F: คำสั่ง build/typecheck/import/migration tooling และหลักฐาน release

## หลักฐาน baseline ล่าสุด (30 ก.ย.)

- Connect `npm run check`: exit 0; Node syntax + SQL ORDER static check ผ่าน
  - 87 files ใน ORDER และ directory
  - เตือน function redefinition/เลข prefix ซ้ำ; ไม่ใช่หลักฐาน migration ใช้จริงใน DB
- CRM `npm run typecheck`: exit 0
- **ยังไม่ได้รัน full suite / end-to-end tracer / module import smoke ในรอบ gate นี้**
- `tests/http.integration.mjs` ของ Connect อ่าน `.env` และเขียนลง container
  `supabase-db` จริงตามโค้ดปัจจุบัน ห้ามรันโดยไม่แยก sandbox และตรวจ target ก่อน
- CRM `tests/helpers/sandbox.ts::resetSchema` ใช้ DROP SCHEMA CASCADE!
  ต้องยืนยันว่า `ASHER_CRM_SANDBOX_DATABASE_URL` ชี้ disposable local DB เท่านั้น
- เทสต์เดิม Connect `tests/contact-contract.db.test.mjs` ใช้ PGlite ผ่าน
  `PGLITE_MODULE` และ fixture เฉพาะ ไม่ได้พิสูจน์ CRM consumption ด้วยตัวมันเอง
- ผลเก่าที่เอกสารกล่าวว่า tests ผ่าน ต้องรันใหม่ก่อนใช้เป็น release evidence

## จุดโค้ดสำหรับเริ่มพรุ่งนี้

### D — Inbox

`public/app.js` ประมาณบรรทัด 510:
`refresh` เรียก `loadList()` แต่ไม่ reset `offset`.
`previous/next` ขยับครั้งละ 50; search debounce 350 ms reset offset เป็น 0 อยู่แล้ว
`loadList` ประมาณ 262 ส่ง offset ไป API; polling เรียก loadList เช่นกัน
หากแก้ refresh ห้ามทำให้ background polling กระโดดกลับหน้าแรกทุกครั้ง
ตรวจ project filtering ซึ่งทำหลัง fetch ด้วย แต่อย่าแก้นอก scope โดยไม่มี gate/test

### E — Error contract

`server.mjs` ประมาณ 139–204: safeCodes เป็น known business codes;
unknown error log แล้ว fallback `400/403 request_rejected` ยกเว้น auth/401
ควรทดสอบ upstream 5xx/unknown SQL error/malformed response + privacy ก่อนแก้
อย่าแก้ด้วยการส่ง raw SQL error/secret กลับ browser

### A — Phone end-to-end

CRM `src/domain/events.ts`:
- `ConnectProfileFields` มี displayName/pictureUrl/status แต่ไม่มี phone
- payloadKnown ไม่รวม `phone`; unknown field ถูก reject
- `validateEnvelope` map profile ยังไม่มี phone

CRM `src/modules/events/service.ts::applyConnectProfile`:
- ไม่มี phone handling
- ชื่อหลัก LINE-first เป็น policy เดิม; อย่าขยาย Messenger name policy เอง
- ใช้ `writeCustomerField` สำหรับ provenance ต้องตรวจ precedence กับ field ใน crm_contacts

Connect มีไฟล์ค้าง `sql/20260929103510_contact_receive_contract.sql` และ
`tests/contact-contract.db.test.mjs` ซึ่งทดสอบ Node extraction → SQL → outbox
แต่ยังไม่เป็น cross-repo tracer ถึง CRM public read boundary

## อาการ “ไม่เห็นแชท” ที่ตรวจใน production แล้ว

หน้า `https://inbox.apluscondo.com/?filter=all` ที่เชื่อมต่ออยู่หน้าท้ายของ pagination
แสดง 11–16 ก.ย.; Prev enabled, Next disabled
ค้นหา `Aom Jyy` → พบ 1 แชท → เปิดแล้ว DOM มีข้อความลูกค้าและข้อความนัดชม 14:00
นี่เป็นหลักฐานว่าแชทอ่านจาก UI ได้ ไม่ใช่ DB-only verification

TypeSafe ผ่าน skill `jev-hosted` ได้ typed choice `pagination` confidence 0.96
และ action `open_chat`. ส่งเฉพาะ sanitized facts ไม่ส่งชื่อ/เบอร์/เนื้อหาแชท
ผล TypeSafe เป็นการประเมินประกอบ ไม่แทนการตรวจหน้าเว็บจริง
ยังไม่ได้แก้ refresh code หรือ deploy; ห้ามรายงานว่าปุ่มถูกแก้แล้ว

## Production imports ที่ทำจริงก่อนงาน gate

### CRM spreadsheet — เสร็จ

`D:\APlusMKT\mkt_data\Contact list 2026.xlsx`
32 source rows: 22 contacts/leads ใหม่ + 10 reused เดิม
9 ambiguous pairs ผู้ใช้เห็นตารางเทียบแล้วรับรองว่าเป็นคนเดียวกัน
เติม phone ที่เดิมว่าง 3 ราย; มี 32 notes; history 3 ราย; rerun zero additions
อ่านรายละเอียด/คำสั่งจาก CRM `docs/contact-list-2026-import.md`
ไม่มีการอนุมาน consent และไม่มีข้อความส่งหาลูกค้า

### Connect Messenger — เสร็จเฉพาะ batch นี้

| ชื่อ | แชทใหม่ | เพิ่มข้อความ | Conversation UUID |
|---|---|---:|---|
| Aom Jyy | ใช่ | 15 | 6e15d40f-a5e3-d236-134a-3132c975ace8 |
| Anfield BW | ไม่ | 3 | 6da552a0-4b75-4e6e-ade1-db7c3e90526e |
| Athiramon Kongchana | ไม่ | 25 | 6d9b7078-6748-45ab-8b20-5226ea58f5b5 |

รวม 43 ข้อความ; committed VPS; repeat preview added=0 ทุกแชท
แชทออมใหม่ human mode/bot off; 2 แชทเดิมไม่เปลี่ยน owner/mode/SLA/status
ไฟล์แนบ 2 message ยังไม่ import; no send/no bot job/no CRM event สำหรับ batch นี้
อ่าน `docs/meta-history-import-2026-09-29.md`.
Artifacts private: `/tmp/asher-meta-import-YM8975/` (0700), `history.json` (0600)
เก็บ local raw sources ไม่ใช่เอกสารสำหรับ publish

### Connect LINE — ก่อนหน้า

เพิ่ม archive 137 events และเติม 19 inbound messages ใน 2 existing conversations
ไม่ได้สร้างแชทใหม่ ดู `docs/backfill-asher-line-2026-09-29.md`
Artifacts `/tmp/asher-browser-x5Q191/`; OA IDs ไม่ใช่ Messaging API IDs ห้ามสวมแทนกัน

### Backfill ค้าง / งานที่ผู้ใช้ให้หยุดวันนี้

- IG: Riw Pries, moo_moo3636, Nuchy, BBAYBBAY, Eart Parinwat ยังไม่ import
  Conversations list อ่านได้ แต่ messages API HTTP 403/code 4 rate limit
- FP เป็น Apr–May; ผู้ใช้อนุญาตขยายก่อน June เป็นกรณีรายเก่าแล้ว แต่ยังไม่ดึง
- พรรักษา / LINE handle minenameprs: ผู้ใช้ส่งเบอร์แล้วในแชท; ยังไม่ผูก OA history
- อย่าเริ่ม backfill ต่อเมื่อมาทำ gates เว้นแต่ผู้ใช้สั่ง; เก็บ pending ไว้แยก
- ณ query ล่าสุด ข้อความวันปกติที่เก่าสุดใน Naii: Messenger 21 ส.ค. 2569,
  LINE OA 2 ก.ย., IG 25 ก.ย.; **ยังไม่ครบ June backfill**
- พบ Messenger 60 events ลงวันที่ปี 1970; ยังไม่แก้ ต้องเพิ่ม gate + สืบ timestamp unit
  ก่อนเปลี่ยนข้อมูลจริง ห้ามเดาค่าแล้ว update ย้อนหลัง

## Environment / access — ไม่มี secret ในเอกสาร

- SSH ที่ผู้ใช้อนุญาต: `root@187.53.139.175`; ใช้ BatchMode + StrictHostKeyChecking
- Connect `/opt/asher-inbox/app` เป็น release symlink; CRM `/opt/asher-crm/app`
- DB container `supabase-db`, database `postgres`; read-only checks ผ่าน SSH stdin
- Deploy ให้ทำตาม `docs/deploy.md`: จาก committed release เท่านั้น,
  ห้าม scp dirty working tree ทับ production; ห้ามแตะ .env/channels.json/sessions
- Ledger ให้บันทึกเฉพาะ migration ที่ตรวจว่าทำแล้วจริง ไม่เติมย้อนหลังจาก ORDER เดาเอง
- Windows Chrome CDP 9223; ห้าม kill/close browser ที่ user เปิด
- agent-browser Windows binary:
  `/home/cheiwchan/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser-win32-x64.exe`
- Sessions: `asher-connect-diagnose` (Connect), `asher-backfill-meta` (Meta),
  `asher-backfill-june` (LINE); ใช้ --pin-tab; tab IDs ต่างกันแต่ละ session!
- ต้องอ่าน skills ใหม่ตามงาน: tdd, diagnosing-bugs, agent-browser,
  Supabase/Postgres หากแตะ SQL; อย่า spawn agents ถ้าไม่มีคำสั่งอนุญาต

## ลำดับทำต่อที่แนะนำ

1. ตรวจ git status/HEAD กับสถานะเครื่องมือใหม่ ไม่ทับงานค้าง
2. เพิ่ม gate checklist ที่มีหลักฐานและคำสั่งชัดเจน ไม่ติ๊กผ่านล่วงหน้า
3. D: browser regression manual refresh ที่ page>1 → fail → reset เฉพาะ manual refresh → pass
4. E: local HTTP upstream mock → unknown errors remain diagnosable + safe response → fix
5. A/B: safe sandbox tracer + CRM phone schema/processing + provenance/precedence tests
6. C: evidence-only clock tests; outbound historical page attribution ไม่เท่ากับ verified human
7. F: typecheck/full safe tests/module-import smoke; report any unverified gate as blocking
8. ก่อน deploy: inspect actual release, backup/checksum, migration status, rollback,
   isolated diff review; ไม่มีการ deploy เพียงเพราะ unit tests ผ่าน
