# PLAN-stats Phase 1 Final Report

วันที่: 2026-09-17 · ผู้ทำ: session admin-7f · deploy source: `C:/Users/ADMin/asher-quick-replies-complete` (prod snapshot — **ไม่ใช่** repo `D:\aplus_postgres_docker\asher-connect` ซึ่งล้าสมัยและมี uncommitted work ของงานอื่น ไม่ได้แตะ)

## 1. Overall Status

**PASS** — หน้า `/stats` ขึ้นเว็บจริง ข้อมูลจริงไหลเข้า trigger แล้ว (4 windows แรกจากแชทจริง) · เหลือ interactive browser check 2 นาทีให้ Ake (login เอง) ดู console/mobile ตาม checklist ท้ายรายงาน

## 2. Before

- App: server.mjs รุ่น QR (schemaVersion ยังไม่มี) · DB version: **ไม่มีระบบเลย** (0 stats functions / 0 tables / ไม่มี ledger)
- `/stats`: HTTP 200 แต่ตัว JS โชว์ "ระบบสถิติยังไม่พร้อมใช้งานบนเครื่องนี้ (ยังไม่ได้ลง sql/016–019)" (แถบแดง — request_rejected จาก RPC ไม่มีในฐาน)
- health: ok:true (worker/inbound ปกติ) ไม่มี field เลขรุ่น

## 3. Root Cause (evidence, ไม่ใช่เดา)

แถบแดงเกิดเพราะ migration `sql/016–019, 027` **ไม่เคยถูกลงบนฐาน VPS** — ตรวจ pg_proc/pg_tables: 0 ฟังก์ชัน 0 ตาราง (`/tmp/statchk2.sql` ก่อน deploy) ขณะที่โค้ดหน้าเว็บ deploy มาพร้อม feature แล้ว รอฐานอยู่อย่างเดียว

## 4. Changes

### Database (ผ่าน `scripts/migrate.mjs --docker supabase-db --only ...`)
- `_ledger.sql` (ทะเบียน inbox.sql_applied) · `016_stats_schema` · `017_stats_functions` (trigger trg_stats_on_message) · `018_stats_api` · `019_stats_seed_cron` (cron ตัวจริง comment ไว้ ไม่เปิด) · `027_stats_v2` (RLS + score_rule + RPC v2 manager-gate) · `039_schema_version` (view + schema_version_latest สำหรับ service role)

### Backend
- `sql/run.mjs`: `--only` (apply เฉพาะชุด) + `--docker <container>` (psql อยู่ใน container, ไฟล์ไหลทาง stdin)
- `server.mjs`: /health เพิ่ม `schemaVersion` (แคช 5 นาที ล้มไม่กระทบ ok)
- `scripts/migrate.mjs` (ใหม่): backup pg_dump ทุกครั้ง → apply → รายงานทางถอย
- `scripts/stats-selftest.mjs` (ใหม่): self-test 13 ข้อ exit-code

### Frontend
- ไม่แตะ — หน้าเดิม (stats.html/js/css) รอฐานอยู่แล้ว ใช้ของเดิมทั้งหมด

## 5. Migration

- files: `_ledger, 016, 017, 018, 019, 027, 039` (--only ตามลำดับ ORDER.txt)
- backup ก่อนลง: `/opt/asher-inbox/backups/pre-stats-20260917-093807.sql` (4.4 MB, header ตรวจแล้ว) + migrate.mjs สร้างซ้ำอีกชั้น `app/backups/backup-2026-09-17T02-40-06.sql`
- before version: (ไม่มีระบบ) → after: **39**

## 6. Production Verification

- public `/stats` (https://inbox.apluscondo.com/stats): **200 PASS**
- stats API: ตรวจระดับฐานด้วยบทบาทจำลอง admin — overview/agents/timeline/open_windows ทำงานทั้งหมด (2–8 ms) · ผ่านหน้าเว็บจริงต้อง login manager/admin (401 สำหรับ anonymous = ถูกต้อง)
- red banner: จะหายเมื่อเปิดด้วยบัญชี manager/admin (RPC ตอบข้อมูลจริงแล้ว — ยืนยันระดับฐาน)
- browser console / mobile: **รอ Ake เปิดจริง** (ไม่มี browser tool + ต้อง login) — checklist ด้านล่าง
- ข้อมูลจริง: `stats_timeline` เจอ **4 windows** แล้ว (แชทจริงหลัง deploy) · `stats_error_log = 0` (trigger ไม่พังแม้ครั้งเดียว)

## 7. Automated Tests

`node scripts/stats-selftest.mjs --docker supabase-db` → **PASS=13, FAIL=0**

[PASS] database connection · [PASS] database version v=39 · [PASS] stats tables (6) · [PASS] stats functions (7) · [PASS] response-window trigger · [PASS] manager/admin profile · [PASS] stats_overview · [PASS] stats_agents · [PASS] stats_timeline · [PASS] invalid date handled · [PASS] no secret-like keys · [PASS] stats_error_log readable (ingest_errors=0)

ก่อน deploy: ทดสอบ local (postgres:16 + stub) — migration 7 ไฟล์ + trigger flow จริง: ลูกค้าทัก→เปิด turn, ทักซ้ำ→inbound_count=2, เซลส์ตอบ 4 นาที→closed `met`, ทักใหม่→turn ใหม่ ✓

## 8. Performance (prod, ช่วง 30 วัน)

overview 8.4 ms · agents 2.3 ms · timeline 0.9 ms · open_windows 0.5 ms · schema_version_latest 2.8 ms — ต่ำกว่าเป้า 500 ms มาก

## 9. Regression

login gate (/api/command anonymous → 401 ✓) · `/` 200 · inbox assets 200 · Quick Replies (`/quick-replies`, `/quick-replies.js`, css) 200 · LINE+Messenger activeChannels=2 · workerLastSuccess/inboundLastSuccess ติ้ง · /health ok:true · logs 10 นาที: 0 error · **ไม่มีการส่งข้อความถึงลูกค้าระหว่างเทสต์**

## 10. Problems Found

1. **SLA สองชั้น config ไม่ตรงกัน** — symptom: `response_window.sla_status` คำนวณจาก `sla_policy` (019 seed: target 900s/15 นาที, เวลาทำการ 09:00–20:00) ขณะที่หน้าจอ/การ์ดโชว์ 5/10 นาที จาก `inbox.settings` (027) · evidence: local trigger test — ตอบ 4 นาที ได้ `met` ทั้งสองชั้น แต่ช่วง 5–15 นาที sla_status จะ `met` ขณะหน้านับ warn · fix (เฟสถัดไป): รวมให้ sla_status ใช้เกณฑ์ 5/10 จาก settings ตัวเดียวกับหน้าจอ (แก้ 019-seed หรือให้ 027 override policy) · test: ยิง turn 5–15 นาทีตรวจ sla_status=warn
2. **ประวัติย้อนหลังยังไม่อยู่ในสถิติ** — หน้าแรกจะเห็นตัวเลขน้อย: turn เริ่มจับเฉพาะข้อความใหม่หลัง 17 ก.ย. ~02:40 · ทางแก้ตามแผน: `stats_backfill` ย้อนหลังตั้งแต่ 15 ก.ย. (017 มี view `v_stats_message` รองรับไว้แล้ว ฟังก์ชัน backfill ยังต้องเขียน — งานเฟสถัดไป)
3. **agents บางแถว name=null** — ตอบจาก workspace แต่ join ชื่อไม่เจอ (หน้ามี fallback "ไม่ระบุชื่อ" แล้ว ไม่ block) · จดตรวจว่าเกิดจาก profile ยังไม่ sync หรือ echo attribution
4. ops: ORDER.txt บน VPS เคยอ้างไฟล์ 038 ที่ไม่อยู่บนดิสก์ (แก้ระหว่างทาง — ส่งไฟล์เก็บครบแล้ว)

## 11. Remaining Risks

- interactive browser/console/mobile ยังไม่ยืนยัน (รอ login จริง) — checklist: เปิด /stats ด้วยบัญชี manager/admin → แถบแดงต้องหาย → การ์ด/กราฟ/ตารางโหลด → สลับวันที่ → console ไม่มี fatal → จอ 390px ไม่ล้น
- cron ของ 028 ยังไม่เปิด (ตั้งใจ — รอเทียบตัวเลขกับระบบเก่าตามหัวไฟล์ 028)
- ข้อ 1–3 ด้านบน

## 12. Rollback

- DB: forward-fix เป็นหลัก (ทุก object ของ stats แยกอยู่ ถอยจุดเดียวได้ เช่น `drop view inbox.schema_version; drop function inbox.schema_version_latest();` + ลบแถว ledger) · disaster recovery: restore จาก `/opt/asher-inbox/backups/pre-stats-20260917-093807.sql`
- App: server.mjs รุ่นก่อนหน้าอยู่ใน image ก่อน build นี้ (`docker compose build` จากไฟล์เดิม) — diff ครั้งนี้เพิ่มเฉพาะบล็อก schemaVersion

## 13. Files Changed

- `sql/run.mjs` (--only, --docker, stdin -f) · `sql/039_schema_version.sql` (ใหม่) · `sql/ORDER.txt` (+039) · `sql/038_*.sql`+selftest (ส่งเก็บครบบน VPS)
- `scripts/migrate.mjs` (ใหม่) · `scripts/stats-selftest.mjs` (ใหม่)
- `server.mjs` (schemaVersion)
- รายงานนี้ + `reports/PLAN-stats-phase1/20260917-093645/baseline.md`

```
PLAN-STATS-PHASE1=PASS
WEB_STATS=PASS
DATABASE=PASS
HEALTH=PASS
AUTOMATED_TEST=PASS
REGRESSION=PASS
```
