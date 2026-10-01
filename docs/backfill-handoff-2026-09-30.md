# Messenger history backfill — handoff (2026-09-30)

## Login incident correction — 2026-09-30

The subsequent pagination UI deployment copied local frontend files onto a different production server version. The deployed app.js statically imported `/conversation-presentation.mjs`, which returned 404. This prevented the entire module from executing, including the login submit handler. API login success did not demonstrate browser login success. The schema-version health warning and browser cache were not established causes.

Recovery: restored public/app.js, public/index.html and public/app.css from `/opt/asher-inbox/rollback/ui-20260929171828`, then rebuilt and recreated asher-connect. The added image-library route remains. Production is modified relative to its deployed-commit marker; do not treat that marker as an exact description of the running files.

Verified using an isolated Chromium session at the public domain with the configured admin test account: login button hides the login panel, renders 50 conversations, produces no browser JavaScript errors, and Next changes the list and enables Previous. No customer message was sent. Database backfill was not changed by this recovery.

Corrections to earlier claims below: the API retrieves 51 rows as a lookahead but the UI displays 50 and advances offset by 50. June 21 is the oldest observed imported valid date, not a proven Meta retrieval limit; coverage back to June 1 is still unverified. A full unlimited import was interrupted; only the first 100 provider conversations were inspected across bounded runs. Import console counts also include transaction status lines and must not be used as exact inserted-message totals. A sample conversation's last_message_at was August 26 while its message history included September 15, so last-message metadata needs a separate audit. Sixty referral events had 1970 timestamps; they are not evidence of historical message coverage.

## สถานะล่าสุด

- Production: `https://inbox.apluscondo.com`
- VPS app: `/opt/asher-inbox/app`
- Deployed release: `fc3c2be8a561643fa7d81fb1bf1aa79b747e65bc`
- Health check: ผ่าน, service healthy, Messenger channel active
- ใช้บัญชี admin ตรวจสอบแล้ว
- ไม่มี backfill process ค้างอยู่

## ผลที่ทำแล้ว

ทำ Messenger backfill ตั้งแต่ `2026-06-01` โดยใช้ Meta Graph API และเขียนผ่าน `connect_private.receive_event` แบบ idempotent

ผลตรวจใน production database ล่าสุด:

- Messenger messages ตั้งแต่ 1 มิ.ย.: `1,151`
- Conversations ที่มีข้อความ: `96`
- วันที่เก่าสุดที่ Meta/API ดึงได้จริง: `2026-06-21`
- วันที่ล่าสุดในชุด backfill: `2026-09-28`
- รอบที่ทำครั้งแรกจำกัดไว้ 50 conversations; รอบต่อมาทำ conversations ที่เหลือแบบทีละรายการจนจบ
- ไม่พบ write failure จากรอบทีละ conversation

## สาเหตุที่หน้าเว็บดูเหมือนเก่าสุด 11 ก.ย.

ไม่ใช่สิทธิ์ admin และไม่ใช่ฐานข้อมูลคนละตัว:

1. หน้า list ใช้ pagination ครั้งละ 51 รายการ
2. หน้าแรกของรายการรวมทุก channel จึงตัดรายการ Messenger เก่าออกจากหน้าปัจจุบัน
3. API production ตรวจแล้วมีหน้าที่ `offset=102` และพบ Messenger conversation เก่าสุดใน list ที่ `2026-08-26`
4. รายละเอียดของ conversation เก่าสุดที่ตรวจผ่าน public API เปิดอ่านข้อความได้ 31 ข้อความ

ให้กด `ถัดไป` ในหน้า list หรือค้นหาชื่อลูกค้าโดยตรง แล้วเปิด conversation เพื่อดูข้อความย้อนหลัง

## คำสั่งตรวจซ้ำบน VPS

```bash
cd /opt/asher-inbox/app
node --env-file=.env scripts/backfill-instagram-history.mjs \
  --channel=messenger \
  --psql-container=supabase-db \
  --from=2026-06-01
```

คำสั่งข้างบนเป็น preview และไม่เขียนข้อมูล หากต้องเติมซ้ำให้เพิ่ม `--apply`; script จะข้าม `external_message_id` ที่มีอยู่แล้ว

ตรวจจำนวนข้อมูล:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -X -At <<'SQL'
select count(*), count(distinct m.conversation_id), min(m.created_at), max(m.created_at)
from inbox.message m
join inbox.conversation c on c.id=m.conversation_id
join inbox.inbox i on i.id=c.inbox_id
where i.channel='messenger' and m.created_at >= '2026-06-01'::timestamptz;
SQL
```

## ข้อจำกัด / งานต่อ

- Meta ไม่คืนข้อมูลย้อนหลังถึง 1 มิ.ย. สำหรับทุก conversation; ข้อมูลที่ตรวจพบเก่าสุดคือ 21 มิ.ย.
- หน้า list แสดง conversation ตาม `last_message_at` ไม่ใช่วันที่ข้อความแรก จึงต้องเปิด conversation หรือใช้ pagination เพื่อดูประวัติเดือนเก่า
- TypeSafe/Jev ยังไม่ได้ใช้วิเคราะห์สำเร็จ เพราะ credential ที่ตั้งไว้ตอบ HTTP 401; ไม่ได้เปิดเผยหรือแก้ credential ใน production
- ควรทำ UI smoke test ด้วย browser จริงหลังผู้ใช้กด `ถัดไป` และเปิด conversation เก่า
