# PLAN-stats — ระบบสถิติการตอบ (ASHER Connect)

ต่อจาก PLAN.md หลัก ใช้เป็น Phase 8.5 (ก่อน Phase 9 conversation_outcomes)

## ไฟล์ในชุดนี้

```
migrations/0001_stats_schema.sql     ตาราง: response_window, agent_daily_stat, sla_policy, signature_alias
migrations/0002_stats_functions.sql  เวลาทำการ, adapter, ingest, trigger, backfill, rollup
migrations/0003_stats_api.sql        RPC stats.* + role gating + ข้อความรายงาน Telegram
migrations/0004_stats_seed_cron.sql  policy เริ่มต้น + pg_cron
migrations/0005_capture_layer.sql    raw payload, ที่มาของลูกค้า (first touch), ความยินยอม PDPA
migrations/0006_outbox.sql           outbox + external_message_id + นโยบายเก็บข้อมูล
tests/00_stubs.sql                   ตาราง stub สำหรับเทสต์
tests/01_scenario.sql                27 เคส สถิติการตอบ
tests/02_capture.sql                 19 เคส ชั้นเก็บข้อมูล
tests/03_outbox.sql                  18 เคส outbox / นโยบายเก็บข้อมูล
parked/                              ร่าง CRM ที่ยังไม่ใช้ (อย่ารัน)
asher-web/lib/stats.ts               client + type สำหรับ Next.js
scripts/send-daily-report.mjs        cron ยิงรายงาน Telegram
```

## ก่อนรัน — ต้องแก้ 2 จุดเท่านั้น

**จุดที่ 1 — `inbox.stats_normalize()` ใน 0002**
แปลงแถวของ `inbox.message` จริงให้เป็นรูปแบบกลาง เขียนไว้แบบ `coalesce` หลายชื่อคอลัมน์
ให้เดาถูกเป็นส่วนใหญ่อยู่แล้ว แต่ต้องเปิดดู schema จริงแล้วยืนยันทีละช่อง:

| ช่อง | ต้องได้ค่าอะไร |
|---|---|
| `conversation_id` | id ของห้องแชท |
| `direction` | `in` = ลูกค้าส่งเข้ามา / `out` = เราส่งออก |
| `actor` | `customer` / `bot` / `human` — **สำคัญสุด** ถ้าแยก bot กับคนไม่ออก ตัวเลข SLA จะสวยปลอมทั้งกระดาน |
| `profile_id` | uuid ของคนตอบ (มีเฉพาะที่ตอบจาก Workspace) |
| `text` | ใช้จับลายเซ็น `-มิ้นท์` |
| `created_at` | เวลาจริงของข้อความ ไม่ใช่เวลาที่ insert |

**จุดที่ 2 — `inbox.stats_actor()` ใน 0003**
ตอนนี้สมมุติว่า `core.profile.id = auth.uid()` ถ้าใช้คอลัมน์อื่นชี้ไป auth user ให้แก้ตรงนี้

แก้เสร็จแล้วรันเทสต์ซ้ำ ต้อง PASS ครบ:

```bash
psql "$DB" -f tests/00_stubs.sql \
           -f migrations/0001_stats_schema.sql \
           -f migrations/0002_stats_functions.sql \
           -f migrations/0003_stats_api.sql \
           -f migrations/0004_stats_seed_cron.sql \
           -f tests/01_scenario.sql
```

(`tests/00_stubs.sql` ใช้เฉพาะบนฐานทดสอบ — อย่ารันบน VPS)

## ลำดับการ deploy

1. รัน 0001–0004 บน Supabase ของ Hostinger (0004 มี `if not exists` รันซ้ำได้)
2. เติม `inbox.signature_alias` ให้ครบทุกคนในทีม — ขั้นนี้ข้ามไม่ได้ ระหว่างที่เซลส์ยังตอบจาก Facebook Page อยู่ ถ้าไม่ผูกลายเซ็น คำตอบจะลงเป็น "ยังระบุตัวไม่ได้" ทั้งหมด
3. เปิด `trg_stats_on_message` (0002 สร้างให้แล้ว) — trigger จับ exception ไว้ ถ้าคำนวณพัง ข้อความยังเข้า ตัว error ไปกองที่ `inbox.stats_error_log`
4. backfill ข้อมูลที่ shadow mode เก็บมา:
   ```sql
   select inbox.rebuild_windows('2026-08-01', now());
   select inbox.rollup_range('2026-08-01', current_date);
   ```
5. เปิด cron 3 ตัวใน 0004 (comment ไว้อยู่)
6. ตั้ง cron ของเครื่องให้ `scripts/send-daily-report.mjs` รัน 08:30 ทุกวัน

## ตรวจหลัง deploy 1 วัน

```sql
select count(*) from inbox.stats_error_log where at > now() - interval '1 day';  -- ต้องเป็น 0
select responder_src, count(*) from inbox.response_window
 where inbound_at > now() - interval '1 day' and first_human_at is not null
 group by 1;
```

ถ้า `unassigned` + `page` รวมกันเกิน ~15% แปลว่าการผูกลายเซ็นยังไม่ครบ — leaderboard รายคนยังใช้ตัดสินใจไม่ได้ ให้ไปเติม `signature_alias` ก่อน ค่านี้โผล่บน dashboard เป็น `attribution_gap_pct` อยู่แล้ว ตั้งใจให้เห็น ไม่ซ่อน

## นิยามที่ฝังอยู่ในโค้ดชุดนี้

- **1 รอบ (response window)** = ลูกค้าทัก → คนตอบ ลูกค้าทักซ้ำก่อนได้คำตอบ ไม่เปิดรอบใหม่ (นับที่ `inbound_count`)
- **bot ตอบไม่ปิดรอบ** เก็บแยกที่ `first_bot_at`
- **SLA ตัดสินด้วย `business_sec`** (หยุดนาฬิกานอกเวลาทำการ) ไม่ใช่ `raw_sec` — เก็บทั้งคู่ไว้เถียงกันได้
- เริ่มต้น 09:00–20:00 ทุกวัน / met ≤ 15 นาที / warn ≤ 60 นาที / เกิน = breach
- **ยังไม่ได้ตอบ** = `first_human_at is null and closed_at is null` ถ้าเกินกำหนดแล้ว cron จะเปลี่ยนเป็น breach ให้เอง
- ค้างเกิน 7 วันถือว่าลูกค้าหายไป ปิดรอบเป็น breach

เปลี่ยนนิยามเมื่อไหร่ ให้แก้ `inbox.sla_policy` แล้วรัน `rebuild_windows` + `rollup_range` ทับ ตัวเลขทั้งชุดจะคำนวณใหม่ตามนิยามใหม่

## ขอบเขต: inbox เท่านั้น

0005 กับ 0006 ทำเพื่อ "รองรับ" CRM และ content ไม่ใช่ "ทำ" สองอย่างนั้น เส้นแบ่งคือ:
อะไรที่เก็บได้เฉพาะตอนข้อมูลไหลผ่าน webhook = งานของ inbox / อะไรที่สร้างย้อนหลัง
ได้จากข้อมูลที่เก็บไว้แล้ว = ไม่ใช่

ตารางทั้งหมดอยู่ใน schema `inbox` โดยตั้งใจ — schema `crm` ต้องว่างจนกว่าจะเริ่ม
โมดูลจริง (มีเทสต์ E2 ใน 03_outbox.sql เช็คข้อนี้อยู่)

โมดูลใหม่ต่อเข้าระบบด้วย outbox เท่านั้น ห้ามเพิ่ม trigger ใน `inbox.message`
และห้ามเพิ่มคอลัมน์สถานะทางธุรกิจใน `inbox.conversation`:

```sql
select * from inbox.outbox_poll('crm', 200);   -- อ่าน
select inbox.outbox_ack('crm', <last_id>);      -- ยืนยัน
```

`ref` ที่ติดมากับลิงก์เก็บดิบไว้ที่ `inbox.acquisition.ref_code` ไม่ตัดไม่แปลง
การตีความว่า ref นี้คือคอนเทนต์ตัวไหน เป็นงานของ content module ตอนที่ตกลง
รูปแบบการตั้งชื่อเสร็จแล้ว

## ยังไม่ได้ทำในรอบนี้

- หน้าจอ Next.js (dashboard / leaderboard / คิวค้างตอบ / drill-down) — รอข้อมูลจริงไหลสัก 1–2 สัปดาห์ก่อน จะได้ออกแบบจากตัวเลขจริง API พร้อมแล้วทั้งหมด
- หน้า admin: channels, users & roles, ตั้ง SLA, config รายงาน, audit log
- Phase 9: ผูก `conversation_outcomes` เข้ากับ `response_window` เพื่อดูว่า "ตอบเร็ว" สัมพันธ์กับ "ปิดการขายได้" จริงไหม — ตารางฝั่งนี้เตรียม `window_id` ไว้ให้ join แล้ว

---

## อัปเดต 2026-09-15 — หน้าสถิติขึ้นแล้ว (sql/027, 028)

★ **"ยังไม่ได้ทำในรอบนี้ — หน้าจอ Next.js" ข้างบนตกไปแล้ว** หน้าจอไม่ได้อยู่ใน
asher-web แต่อยู่ใน `asher-connect/public/stats.html|js|css` เสิร์ฟจาก `server.mjs`
(`staticFiles` เป็น allowlist แบบตรงเป๊ะ ไฟล์ใหม่ต้องใส่ในตารางนั้นด้วย ไม่งั้น 404)
เพราะ 2026-09-12 ตัดสินใจแล้วว่า asher-connect คือชั้นแอปตัวจริงของงานเซลส์

### สิ่งที่ sql/027 เปลี่ยนจากแผนเดิม

| หัวข้อ | แผนเดิมในไฟล์นี้ | ของจริงตอนนี้ |
|---|---|---|
| เวลาทำการ | 09:00–20:00 | **06:00–24:00** = 24 ชม. หัก 00:00–06:00 |
| met / warn / breach | 15 / 60 นาที | **5 / 10 นาที** (จาก `inbox.settings`) |
| ด่านสิทธิ์ | overview/timeline = sales | **manager ขึ้นไปทุกตัว** บังคับที่ `stats_scope` ตัวเดียว |
| RLS | ไม่มีเลยทั้ง 5 ตาราง | เปิดครบ + revoke + ทางเข้าเดียวคือ RPC (security definer) |
| คะแนน | ไม่มี | `inbox.score_rule` ปรับได้ · เข้าทั้ง leaderboard และรายงาน Telegram |
| ตัวกรอง | มีแค่ใน overview | timeline/agents รับ `channel`/`project` ด้วยแล้ว |

★ **ขั้นตอน "เติม signature_alias ให้ครบทีม" ถูกยกเลิก** — ผู้ใช้ตัดสินใจ 2026-09-15
ว่าจะแก้เรื่องชื่อด้วยการให้ทีมย้ายมาตอบผ่าน Connect (ซึ่งมี `sender_id` อยู่แล้ว)
ของเก่าที่ไม่มีชื่อรวมเป็นถังเดียวไปก่อน ตาราง `signature_alias` ยังอยู่แต่ปล่อยว่าง
→ `attribution_gap_pct` จึงเปลี่ยนความหมายจาก "ผูกลายเซ็นไม่ครบ ต้องไปแก้"
เป็น **ตัววัดความคืบหน้าการย้ายเข้า Connect** ซึ่งจะลดลงเอง ไม่ใช่ error

### ที่ยังไม่ได้ทำ

- ยังไม่ได้ลงฐานจริง — ต้องยืนยันก่อนว่า 016–019 อยู่บน VPS แล้วหรือยัง
- หลังลง 027 ต้อง `rebuild_windows` + `rollup` ย้อนหลัง ไม่งั้นตัวเลขจะเป็นของสองนิยามปนกัน
- cron ของระบบเก่า (`asher-report-daily` ใน sql/011) **ยังเปิดอยู่โดยตั้งใจ**
  ให้เดินขนานกับของใหม่ก่อน แล้วค่อยตัดสินใจ cutover

