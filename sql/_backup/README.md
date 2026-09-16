# sql/_backup — นิยามจริงบนโปรดักชัน ก่อนแก้แต่ละครั้ง

ทุกไฟล์ในโฟลเดอร์นี้ดึงมาจากฐานโปรดักชัน (`root@187.53.139.175` → `supabase-db`)
ด้วย `pg_get_functiondef()` **ไม่ได้คัดมาจากไฟล์ใน `sql/`** — เพราะกับดักของที่นี่คือ
"ไฟล์กับฐานไม่ตรงกันโดยไม่มีอะไรฟ้อง" ถ้าสำรองจากไฟล์ก็จะสำรองความเข้าใจผิดไปด้วย

วิธีดึง (รูปแบบเดียวกันทุกไฟล์):

```bash
ssh root@187.53.139.175 'docker exec supabase-db psql -U postgres -d postgres -Atc \
  "select pg_get_functiondef(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '"'"'<schema>'"'"' and p.proname = '"'"'<name>'"'"';"' \
  > sql/_backup/<name>_prod_<YYYYMMDD>.sql
```

วิธีย้อนกลับ: ไฟล์เหล่านี้เป็น `CREATE OR REPLACE FUNCTION` ที่สมบูรณ์อยู่แล้ว
`psql -v ON_ERROR_STOP=1 -f <ไฟล์>` ได้ทันที (ห่อ `begin; … rollback;` ซ้อมก่อนทุกครั้ง)
`create or replace` ไม่ล้าง ACL เดิม จึงไม่ต้อง grant ใหม่

## ทะเบียนไฟล์

| ไฟล์ | ดึงเมื่อ | ก่อนจะแก้ด้วย | สภาพตอนที่ดึง |
|---|---|---|---|
| `worker_prod_20260916.sql` | 2026-09-16 04:34Z | `032_worker_resync.sql` | รุ่นที่ถูก `002` รันทับ เหลือ 8 จาก 21 action |
| `receive_event_prod_20260916.sql` | 2026-09-16 04:34Z | `033_receive_event_resync.sql` | รุ่นที่ถูก `002` รันทับ กิ่ง `group_command` หาย |
| `api_prod_20260916.sql` | 2026-09-16 04:34Z | (ยังไม่ถูกแก้ — ดึงไว้เพราะ `002` แตะ `api` ด้วยในอดีต) | ปกติ |
| `receive_event_prod_20260916_pre035.sql` | 2026-09-16 06:0xZ | `035_echo_attribution.sql` | รุ่น 033 (กิ่ง echo ยังตัดสินสองทาง bot/agent และไม่กันข้อความของเราเองซ้ำ) |
| `receive_event_prod_20260916_pre036.sql` | 2026-09-16 06:05Z | `036_echo_source_from_queue.sql` | รุ่น 035 (ป้าย source ยังตัดสินจาก app_id ก่อน) |
| `refresh_sales_staff_kpi_daily_prod_20260916.sql` | 2026-09-16 05:5xZ | `034_kpi_refresh_resync.sql` | รุ่นของ `009` (คำนวณในตัวเอง) ที่ทับรุ่นของ `011` (เรียก `inbox.reply_stats`) — ผลลัพธ์เท่ากันทุกตัวเลข |

## เหตุการณ์ 2026-09-16 (ที่มาของไฟล์ทั้งหมดนี้)

ราว 04:21 UTC มีการรัน `sql/002_decide.sql` ทั้งไฟล์ใส่โปรดักชัน และวันเดียวกัน
มีการรัน `009/013/023/029/030/031` ทั้งไฟล์ (งาน is_test/คำสั่ง test)
ผลคือ object ที่ไฟล์หลัง ๆ เป็นเจ้าของรุ่นล่าสุดถูกย้อนรุ่นเงียบ ๆ 4 ตัว:

- `connect_private.worker` → เหลือ 8 จาก 21 action · ส่งข้อความหาลูกค้าไม่ได้ 37 นาที
- `connect_private.receive_event` → กิ่ง `group_command` / `reply_token` / welcome / ad หาย
- `inbox.extract_phone` → เสีย fix ของ `014` จับเบอร์ลูกค้าไม่ได้
- `inbox.refresh_sales_staff_kpi_daily` → กลับไปเป็นรุ่นคำนวณในตัวเองของ `009` (ผลเท่ากัน)

กันซ้ำแล้วด้วย guard ที่หัว **ทุก transaction** ของ `002/003/004/006/007/008` (+ `009` สำหรับ KPI)
รายละเอียดอยู่ในหัวไฟล์ `032_worker_resync.sql`
