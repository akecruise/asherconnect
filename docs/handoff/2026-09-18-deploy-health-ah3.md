# DEPLOY HANDOFF — System Health + Answer Hub Phase 0–3 → VPS โปรดักชัน (2026-09-18)

> งาน deploy **เตรียมไว้ครบแล้ว ยังไม่ได้รันขึ้น VPS** — agent ถัดไปเริ่มที่ "PHASE 1" ได้ทันที
> ผู้ใช้อนุมัติ deploy แล้ว (ข้อความ 12 กฎ 2026-09-18) · session answer-hub **ถูกหยุดโดยผู้ใช้แล้ว** สนามนิ่ง

## สิ่งที่ deploy นี้เอาขึ้นจริง

| ชิ้นงาน | สถานะท้องถิ่น | ไป VPS ด้วย |
|---|---|---|
| System Health (health/ + server.mjs + sql 2 ไฟล์) | integration 68/68 · unit 178/178 | ไฟล์ + migration 2 ไฟล์ |
| Answer Hub Phase 1–3 (schema answer_hub + ah_* + version) | selftest ผ่าน · ปิด Phase สะอาด | migration 3 ไฟล์ |
| Answer Hub **Phase 4** (source registry — session คู่ขนานปิด 05:38) | selftest ผ่านตามทะเบียนมัน | **โค้ดเฉพาะ 2 action ใน AH_ACTIONS** (`ah_source_list`, `ah_source_save`) — migration `202609180530_source_registry.sql` **ห้ามลง** (ไม่อยู่ในลิสต์ 5 ไฟล์) |

⚠️ **known limitation ที่ต้องแจ้งผู้ใช้หลัง deploy**: action `ah_source_list/ah_source_save` จะตอบ error
(หา RPC ไม่เจอ) จนกว่าจะลง migration Phase 4 อีกครั้งหนึ่ง — ไม่กระทบทางเดินอื่น ไม่ auto-trigger

## กฎ 12 ข้อของผู้ใช้ (ต้องอ่านก่อนรันทุกครั้ง)

1. ห้ามแตะ/เขียนทับ `.env` และ `channels.json` บน VPS (ยกเว้นเพิ่ม `APP_VERSION` ข้อ 11)
2. ห้ามแสดง secret/token/password/connection string ใน output/log
3. ห้ามรัน `sql:apply` ทั้งชุด — **เหตุผล: ทะเบียน VPS มีแค่ 8 ไฟล์ ไฟล์เก่าเคยลงด้วย psql ตรง ๆ จะโดนยิงซ้ำทั้งกอง**
4. ลงเฉพาะ 5 migration ตามลำดับ: `202609172025_health` → `202609172100_answer_hub_foundation` → `202609172130_system_status` → `202609172145_answer_item` → `202609180430_answer_version`
5. migration fail = หยุดทันที ห้ามไฟล์ถัดไป รายงาน error
6. ห้ามลบ database/table/function เดิมเพื่อบังคับ migration ผ่าน
7. รักษา backup: `/opt/asher-inbox/backup-health-ah3-20260918.tar.gz` (2.7M — มีอยู่จริงแล้ว)
8. ก่อน write ทุกขั้น ตรวจ current state ก่อน
9. ถ้า answer-hub มี concurrent change ใหม่หลังชุดเทสต์ล่าสุด = หยุดรายงานก่อน
10. `HEALTH_TELEGRAM_TOKEN/CHAT_ID` ยังไม่ตั้งรอบนี้ (ระบบเช็คทำงานได้ ขั้น Telegram ขึ้น "ข้าม")
11. เพิ่ม `APP_VERSION` ได้ ห้ามแตะ secret อื่นใน `.env`
12. ทุกคำสั่ง production fail-fast

## สภาพสนาม ณ หยุดงาน (2026-09-18 ~05:40)

- **VPS 187.53.139.175** (`root@…`, `/opt/asher-inbox/app`): container `asher-connect` healthy ·
  supabase stack ครบ · disk เหลือ 82G · **ไม่มี psql บนโฮสต์** (ใช้ `docker exec supabase-db psql`)
  · node มีบนโฮสต์ (`/usr/bin/node`) · `.env` มี key: META_*, SUPABASE_*, CONNECT_*, TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID, LINE_*, ANTHROPIC_API_KEY, TEST_USER_IDS — **ยังไม่มี APP_VERSION/HEALTH_TELEGRAM_***
- **ทะเบียน `inbox.sql_applied` มี 8 แถว**: _ledger, 016–019 stats, 027_stats_v2, 039_schema_version, 040_meta_review
- **backup**: `/opt/asher-inbox/backup-health-ah3-20260918.tar.gz` สร้างแล้ว (tar ทั้ง app/ ก่อนแตะอะไร)
- **ท้องถิ่น**: `npm run check` ผ่าน · unit 178 fail 0 · integration **68/68** (รันเวลา ~05:36–05:39
  บน state ก่อน Phase 4 ปิด — **ต้องรันซ้ำบน state ปัจจุบันก่อน deploy** ดู PHASE 0)
- Phase 4 ปิดหลังเทสต์ชุดนั้น: server.mjs เพิ่ม 2 action (บรรทัด 220) + `sql/202609180530_source_registry.sql`
  + ORDER.txt บรรทัด 175

## PHASE 0 — PRE-FLIGHT (รันซ้ำบน state ปัจจุบัน — บังคับ)

```bash
cd "D:/aplus_postgres_docker/asher-connect"
git status --short                                   # จะเห็นงานค้างหลายไฟล์ = ปกติ (repo ไม่มี remote, งานไม่เคย commit)
npm run check
node --test tests/auth.test.mjs && node --test tests/profile.test.mjs && node --test tests/providers.test.mjs \
  && node --test tests/bots.test.mjs && node --test tests/testcmd.test.mjs && node --test tests/report.test.mjs \
  && node --test tests/outcomes.test.mjs && node --test tests/decide.test.mjs \
  && node --test tests/media.test.mjs tests/media-http.test.mjs     # ต้อง fail 0
node tests/http.integration.mjs                       # ต้อง 68/68
# กฎข้อ 9: หาไฟล์ที่เปลี่ยนระหว่างเทสต์
find server.mjs auth.mjs providers.mjs package.json public bots reports lib scripts health sql tests Dockerfile docker-compose.yml -newer <ไฟล์กำหนดเวลา> -type f
```
**ไม่ครบ 68/68 หรือ fail ไม่ 0 หรือมีไฟล์ขยับระหว่างเทสต์ = STOP รายงาน**

## PHASE 1 — VPS READ-ONLY CHECK

```bash
ssh root@187.53.139.175 '
docker compose -f /opt/asher-inbox/app/docker-compose.yml ps
docker ps --format "{{.Names}}  {{.Status}}" | grep -E "asher-connect|supabase-db"
df -h / | tail -1
ls -la /opt/asher-inbox/backup-health-ah3-20260918.tar.gz     # ต้อง size > 0
grep -oE "^[A-Za-z_]+" /opt/asher-inbox/app/.env | tr "\n" " "  # ชื่อ key เท่านั้น ห้าม print value
docker exec supabase-db psql -U supabase_admin -d postgres -tAc \
  "select column_name from information_schema.columns where table_schema='"'"'inbox'"'"' and table_name='"'"'sql_applied'"'"' order by ordinal_position"
docker exec supabase-db psql -U supabase_admin -d postgres -tAc "select filename from inbox.sql_applied order by filename"
'
```
- ทะเบียนต้อง**ไม่มี**ทั้ง 5 ไฟล์ (ถ้ามี = ห้าม apply ซ้ำอัตโนมัติ ตรวจ sha ก่อนแล้วรายงาน)
- รู้ล่วงหน้า: คอลัมน์ทะเบียนคือ `filename, sha256, applied_at, applied_by` (run.mjs insert แบบนี้) — **แต่ต้อง inspect ซ้ำตอนรันจริงตามกฎข้อ 8**

## PHASE 2 — PACKAGE / UPLOAD

```bash
cd "D:/aplus_postgres_docker/asher-connect"
# ลายนิ้วมือไฟล์แกนก่อนส่ง (เทียบปลายทางทีหลัง — กัน race กับ session อื่น)
sha256sum server.mjs auth.mjs providers.mjs package.json Dockerfile > /tmp/deploy-sha-local.txt
tar czf - --exclude='*.bak*' --exclude='sql/_backup' --exclude='sql/_backfill' --exclude='sql/_selftest' \
  --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='channels.json' --exclude='.health-audit' \
  server.mjs auth.mjs providers.mjs package.json public bots reports lib scripts health sql Dockerfile docker-compose.yml \
  | ssh root@187.53.139.175 'tar xzf - -C /opt/asher-inbox/app'
# ตรวจหลังส่ง: ไฟล์แกน sha ต้องตรง + .env/channels.json ไม่โดนแตะ
ssh root@187.53.139.175 'cd /opt/asher-inbox/app && sha256sum server.mjs auth.mjs providers.mjs package.json Dockerfile'
ssh root@187.53.139.175 'stat -c "%n %Y" /opt/asher-inbox/app/.env /opt/asher-inbox/app/channels.json'
```
- sha ไม่ตรง = STOP (มีคนแตะระหว่างทาง)
- **จด mtime (epoch) ของ .env/channels.json ไว้เทียบหลัง extract** — tar ไม่มีชื่อไฟล์สองตัวนี้อยู่แล้ว ต้องไม่เปลี่ยน
- หมายเหตุ: repo ไม่มี `package-lock.json` (นโยบาย zero-dep) — ตัดจากลิสต์ได้ ไม่ใช่ของหาย
- `sql/202609180530_source_registry.sql` **ส่งขึ้นได้** (เป็นแค่ไฟล์นอน ไม่มีใครรันมัน — ตัวรันจริงคือลิสต์ 5 ไฟล์ใน PHASE 3) แต่**ห้าม**ไปอยู่ในลิสต์ apply

## PHASE 3 — DATABASE MIGRATION (5 ไฟล์ ทีละไฟล์ จาก /opt/asher-inbox/app)

```bash
ssh root@187.53.139.175 'cd /opt/asher-inbox/app && docker exec -i supabase-db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -q -f -' \
  < sql/202609172025_health.sql
```
- รัน**ทีละไฟล์ตามลำดับ** · error = STOP ทันที (กฎ 5)
- หลังแต่ละไฟล์ผ่าน ตรวจของที่มันสร้าง (ปรับชุดตามไฟล์):

| ไฟล์ | ตรวจหลัง apply |
|---|---|
| 202609172025_health | `\df inbox.health_ping/health_snapshot/health_rule_save` · `select count(*) from inbox.monitor_rule` (กฎ health ชุดใหม่) |
| 202609172100_answer_hub_foundation | `select schema_name from information_schema.schemata where schema_name='answer_hub'` · ตาราง 4: answer_category/intent/question_pattern (+ seed 10/10) |
| 202609172130_system_status | `\df inbox.health_thresholds/health_queue` · constraint `monitor_rule_kind_check` มี 'worker_age' · กฎ worker 4 อัน |
| 202609172145_answer_item | ตาราง `answer_hub.answer_item` · ฟังก์ชัน ah_list/ah_get/ah_save/ah_approve/ah_retire |
| 202609180430_answer_version | ตาราง `answer_hub.answer_version` · ฟังก์ชัน `_snapshot_version` · ah_save/ah_retire รุ่นใหม่ · `ah_versions` |

- **บันทึกทะเบียน** หลังแต่ละไฟล์ผ่าน — sha ต้องมาจากไฟล์จริงบน VPS (utf8) ให้ตรงกับวิธีของ run.mjs:
```bash
ssh root@187.53.139.175 'cd /opt/asher-inbox/app && node -e "
const {createHash}=require(\"node:crypto\"),{readFileSync}=require(\"node:fs\");
const f=process.argv[1];
console.log(f+\" \"+createHash(\"sha256\").update(readFileSync(f,\"utf8\")).digest(\"hex\"));
" sql/202609172025_health.sql'
# แล้ว insert (ห้ามเดา column — ใช้ชุดที่ inspect ไว้):
#   insert into inbox.sql_applied(filename, sha256) values ('<ไฟล์>', '<sha>')
#   on conflict (filename) do update set sha256=excluded.sha256, applied_at=now(), applied_by=current_user;
# ตรวจซ้ำ: select filename, left(sha256,12) from inbox.sql_applied where filename like '2026091%' or filename like '_ledger';
```

## PHASE 4 — APP_VERSION (ข้อ 11)

```bash
ssh root@187.53.139.175 'grep -c "^APP_VERSION=" /opt/asher-inbox/app/.env || true'
# ไม่มี = append; มี = แทนบรรทัดเดียว ห้ามแตะบรรทัดอื่น:
ssh root@187.53.139.175 'echo "APP_VERSION=2026.09.18-health-ah3" >> /opt/asher-inbox/app/.env \
  && grep -oE "^[A-Za-z_]+" /opt/asher-inbox/app/.env | sort | sha256sum'   # เทียบชุด key ก่อน-หลัง ต้องต่างกันแค่ APP_VERSION
```

## PHASE 5 — BUILD / START

```bash
ssh root@187.53.139.175 'cd /opt/asher-inbox/app && docker compose config -q && docker compose build 2>&1 | tail -5 && docker compose up -d && sleep 12 && docker compose ps'
```
- container ไม่ healthy / restart loop = **STOP** · เก็บ `docker logs asher-connect --tail 100` รายงาน · ห้ามแก้มั่ว
- rollback ไฟล์: `cd /opt/asher-inbox && tar xzf backup-health-ah3-20260918.tar.gz` (ทับ app/) + rebuild

## PHASE 6 — PRODUCTION VERIFICATION

```bash
ssh root@187.53.139.175 '
curl -s -o /dev/null -w "healthz %{http_code}\n" http://127.0.0.1:3200/healthz
curl -s http://127.0.0.1:3200/health | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const h=JSON.parse(d);console.log(JSON.stringify({ok:h.ok,status:h.status,db:h.database?.status,workers:[h.workers?.inbound?.status,h.workers?.outbound?.status],queue:h.queue?.status,ver:h.version,up:h.uptimeSec}))})"
curl -s -o /dev/null -w "admin-health-no-login %{http_code}\n" http://127.0.0.1:3200/api/admin/system-health
curl -s -X POST -o /dev/null -w "selftest-no-login %{http_code}\n" http://127.0.0.1:3200/api/admin/system-health/test
docker logs asher-connect --since 5m 2>&1 | grep -cE "request_failed|Unhandled|TypeError|ECONN|FATAL" || true'
```
- คาดหมาย: `/healthz` 200 · `/health` JSON ครบ status/database/workers/queue/version · ไม่ล็อกอิน = 401 (expected)
- **ส่วนที่ agent ทำเองไม่ได้**: ล็อกอิน admin จริง → หน้า `/admin/health` → ปุ่มตรวจ → ต้อง 200 + steps เป็น array
  (ไม่มีรหัส admin บน prod และห้ามขอ — ให้ผู้ใช้ทดสอบในเบราว์เซอร์ แล้วดู log ว่าไม่มี `request_failed` เพิ่ม)
- แยก expected (401/403 จากด่านสิทธิ์) ออกจาก application error เสมอ

## PHASE 7 — ANSWER HUB SMOKE (อ่านอย่างเดียว ไม่แตะข้อมูลลูกค้า)

```bash
ssh root@187.53.139.175 'docker exec supabase-db psql -U supabase_admin -d postgres -tAc "
select count(*) from information_schema.tables where table_schema='"'"'answer_hub'"'"';
select count(*) from answer_hub.answer_category;   -- คาด 10 (seed)
select count(*) from answer_hub.intent;            -- คาด 10 (seed)
select proname from pg_proc where pronamespace='"'"'answer_hub'"'"'::regnamespace order by 1;"
docker exec supabase-db psql -U supabase_admin -d postgres -tAc \
  "select proname from pg_proc where proname like '"'"'ah_%'"'"' order by 1"'
```
- คาดหมาย: ฟังก์ชัน ah_list/ah_get/ah_save/ah_approve/ah_retire/ah_versions พร้อม ·
  **ah_source_list/ah_source_save จะยังไม่มี = ถูกต้องตามแผน** (ห้ามทดสอบ action คู่นั้นบน prod)

## PHASE 8 — FINAL REPORT (ตารางตามที่ผู้ใช้กำหนด)

Pre-flight tests · Upload · .env protected · channels.json protected · Migration 1–5 · Migration registry/SHA ·
Docker build · Docker up · /healthz · /health · Admin System Health · Admin Self Test · Authorization ·
Answer Hub smoke test · Production logs — สรุปท้าย: **DEPLOYED / PARTIAL / ROLLED BACK / STOPPED**
พร้อม app version · container status · migrations ที่ apply จริง · health status · จำนวนเทสต์ · error ค้าง
**ห้ามบอกสำเร็จจนกว่า verification สำคัญจะผ่านจริง**

## Rollback สรุป

- ไฟล์: restore backup tar (PHASE 5) · image เก่า: `docker images | grep app-asher-connect` (compose สร้างใหม่ทับ tag เดิม — ถ้าต้องการ image เก่าจริง ๆ ให้จด IMAGE ID ก่อน build)
- DB: ทั้ง 5 ไฟล์ additive (create or replace / create table / drop+add constraint เดิม) — ถอยตาม
  "How to rollback safely" ใน `HEALTH-CHECK-HANDOFF.md` (คืน health_snapshot/health_rule_save รุ่นเดิมด้วยการ
  รัน `202609172025_health.sql` ซ้ำ + disable กฎ worker_age) · answer_hub schema ไม่ต้องถอยถ้าไม่จำเป็น
- ฉุกเฉินส่งขาออก: ปิด `send.live_enabled` ที่ `inbox.bot_config` (มีผลใน 3 วิ) — deploy นี้ไม่แตะค่านี้

## ความเชื่อมโยง

- รายละเอียดงาน health: `HEALTH-CHECK-HANDOFF.md` (root) · `docs/admin-system-status.md`
- งาน answer-hub: `docs/answer-hub/HANDOFF.md` (Phase 4 ปิดแล้ว รอลง migration วันหลัง)
- deploy ครั้งก่อน + กับดัก VPS: memory `asher-connect-vps-deploy` (channels.json = uid 1000 ห้าม chown -R)

## ⚠️ บันทึกเหตุการณ์รอบ deploy UI (2026-09-18 รอบสอง) — ROLLED BACK

งานรวมหน้า /admin/health เข้า UI หลัก (app.js + app.css + route preempt + endpoint /api/admin/health-rule
+ เทสต์ 69-72) เขียวเต็มชุดท้องถิ่น **72/72 + unit 178/0** แต่ deploy จริง **STOPPED → ROLLED BACK**:

- สาเหตุ: `server.mjs` ท้องถิ่นถูก session คู่ขนาน (answer-hub Phase 5-6) แตะเพิ่มระหว่างทาง —
  ไฟล์ที่ส่งขึ้นพา import `./services/answer-hub/service.mjs` ไปด้วย แต่ไม่ได้ส่ง `services/`
  และ Dockerfile ไม่มี `COPY services` → `ERR_MODULE_NOT_FOUND` ตอน boot → restart loop
- จัดการ: restore จาก `/opt/asher-inbox/backup-ui-health-20260918/` (server.mjs + public/app.js + app.css)
  → rebuild → healthy กลับมา (prod = เวอร์ชันเช้า 2026.09.18-health-ah3 หน้า standalone ยังทำงานตามเดิม)
- บทเรียน: ก่อนส่ง server.mjs **ต้องสแกน import ทั้งไฟล์** เทียบกับสิ่งที่มีบน VPS + Dockerfile ทุกครั้ง
  งาน session คู่ขนานปนในไฟล์เดียวกันทำให้ "ส่งเฉพาะของตัวเอง" ไม่มีทางเป็นไปได้กับ server.mjs

## ทางเดินต่อ (เมื่อ session คู่ขนานหยุดนิ่งแล้ว)

1. หยุด/ฟรีซ session answer-hub ให้สิ้นซัง (ขณะเกิดเหตุมันกำลังทำ Phase 6: ah_resolve/ah_binding_*)
2. สแกน import ของ server.mjs ทั้งไฟล์ → ส่งให้ครบทุกไฟล์ที่ import (รวม `services/`) + เติม
   `COPY services ./services` (และอื่น ๆ ที่ขาด) ใน Dockerfile
3. pre-flight ใหม่ทั้งชุด (check + unit + integration 72 ข้อ) บน state สุดท้าย · ตรึง sha · ตรวจซ้ำตอนอัป
4. migration Phase 5/6 ของ answer-hub **ยังไม่ลง** (ตามกฎไม่แตะ DB ในงาน UI) — actions ใหม่จะ error
   อย่างมีระเบียบจนกว่าจะลง migration แยก — จด known limitation เหมือน Phase 4
5. deploy → smoke ตามหัว PHASE 6-7 ของไฟล์นี้ (รวม session จริงด้วยบัญชีบริการบนเครื่อง ไม่พิมพ์ secret)
