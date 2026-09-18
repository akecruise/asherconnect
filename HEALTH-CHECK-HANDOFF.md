# HEALTH-CHECK-HANDOFF — มอบงานต่อให้ agent ถัดไป (2026-09-18)

> ✅ **เสร็จสมบูรณ์ 2026-09-18** — integration 68/68 ผ่านหมด (root cause ของข้อ 67 อยู่ในหัว "ข้อ 67") · งานถัดไปคือลง VPS ตามหัว "Next phase"

## Status

| ชิ้นงาน | สถานะ |
|---|---|
| ระบบเช็คพื้นฐาน (health/ + sql/202609172025_health.sql) | ✅ เสร็จ พิสูจน์แล้ว (migration รัน 2 รอบผ่าน · กฎ 11 ข้อยิงถูก/ไม่ซ้ำ/กลับมาปกติ · สิทธิ์ sales โดน 42501) |
| `/health` ขยายสถานะรวม (additive) | ✅ เสร็จ — field เดิมครบ + status/checkedAt/uptimeSec/version/database/channels/workers/queue/shadowMode |
| `GET /api/admin/system-health` | ✅ เทสต์ผ่าน (62 ไม่ล็อกอิน→401 · 63 เซลส์→403 · 64 admin→200 ครบทุกส่วน ไม่มี secret หลุด) |
| `POST /api/admin/system-health/test` | ✅ เทสต์ผ่าน (67: เซลส์→403 · admin→200 ครบ contract ไม่มี secret หลุด) |
| Health Rules แก้ได้จากหน้าเว็บ | ✅ เทสต์ผ่าน (68: ค่า 0 ถูกปฏิเสธ ชั่วโมงกลับด้านถูกปฏิเสธ บันทึก 30 นาทีได้ คืนค่าได้) |
| ฐานล่ม → status down + 503 | ✅ เทสต์ผ่าน (66) |
| เทสต์เก่ายุค "ไม่มีล็อกอิน" 14 ข้อ | ✅ แก้ให้ตรงยุคล็อกอินรายบุคคลแล้ว (login ผ่านคุกกี้ asher_session) |
| เมนู "สถานะระบบ" เฉพาะ admin | ✅ (index.html `#nav-admin-status` + app.js `wireAppNav`) |
| เอกสาร | ✅ `docs/admin-system-status.md` + README แล้ว · ไฟล์นี้ |
| **ผลรวม integration** | **68/68 ผ่านหมด** |

## Architecture — ต่อยอดของเดิม ไม่มีระบบซ้ำ

```
หน้าเว็บ /admin/health (public/health.html+js+css เสิร์ฟโดย health/health.mjs)
   ├─ GET /api/health/snapshot  → SQL health_snapshot() + snap.system (จาก server)
   ├─ POST /api/health/rule     → SQL health_rule_save() (admin เท่านั้น ตรวจค่าใน SQL)
   └─ POST /api/health/selftest → flowHealth.selftest() + systemExtraTests() ของ server

เส้นทาง admin ใหม่ (ใน server.mjs route() ก่อนด่าน 405)
   ├─ GET  /api/admin/system-health      → sessions.access + health_can_view() → fullSystemStatus()
   └─ POST /api/admin/system-health/test → เดียวกัน + flowHealth.selftest()

/health  (สาธารณะ, docker healthcheck) → health() + สถานะรวมจาก sysCache (ไม่บล็อก)
/healthz (สาธารณะ, UptimeRobot)        → flowHealth.handle → probeDb → 200/503
```

- **ตัวคำนวณ overall (HEALTHY/DEGRADED/DOWN) อยู่ที่ server.mjs `computeSystemStatus()` จุดเดียว**
  หน้าเว็บแค่แสดง ห้ามสรุปเอง แคช 15 วินาที (stale-while-revalidate, รอบแรกหลังบูต 1.5 วินาที)
- เกณฑ์ worker/คิวอ่านจาก `inbox.health_thresholds()` (ตารางกฎเดิม — admin แก้หน้าเว็บ มีผลทันที)
- `systemExtraTests()` ยิงเพิ่มใน self-test: worker สองคิว · คิวงาน · โหมดเงา · ตัวแปรจำเป็น (รายงานแค่ configured/missing)
- ท่อเดิมทั้งหมดยังทำงาน: health.log 6 จุด, tick ทุกนาที, Telegram, worker, webhook, โหมดเงา
- ปิดตัวเช็คได้ด้วย `CONNECT_HEALTH=off` (ชุดทดสอบตั้งให้แล้วใน tests/http.integration.mjs)

## Files changed (ชุดงานนี้)

- `server.mjs` — createHealth เพิ่ม opts `getSystemStatus`/`extraSelfTests` · `computeSystemStatus()/refreshSystemStatus()/fullSystemStatus()/systemExtraTests()/workerState()` · health() เพิ่ม field แบบ additive · route() เพิ่มสอง endpoint · sysTimer + SIGTERM
- `health/health.mjs` — snapshot แนบ `snap.system` · selftest ต่อท้าย extraSelfTests · rpc แปลง 4xx เป็น 400 (เดิม 502)
- `public/health.html|js|css` — ป้าย HEALTHY/DEGRADED/DOWN, sysmeta (uptime/version/environment), การ์ด Inbound/Outbound/Queue/Shadow, ปุ่มรีเฟรช, MAIN_PARAM เพิ่ม worker_age
- `public/index.html` + `public/app.js` — เมนู `#nav-admin-status` แสดงเฉพาะ admin
- `sql/202609172130_system_status.sql` (ใหม่) + ลงทะเบียนใน `sql/ORDER.txt`
- `tests/http.integration.mjs` — login()/commandAs() helpers · เขียนข้อ 10-18, 21, 28-31, 34, 48, 60 ใหม่ · เพิ่ม 62-68 · แก้เช็ค secret ข้อ 67 ให้เป็น `JSON.stringify(body)` (ตามข้อ 64)
- `docs/admin-system-status.md` (ใหม่) · `README.md` (เพิ่ม section) · ไฟล์นี้

⚠️ **มีอีก session ทำงานคู่ขนานใน repo นี้** (answer-hub: `sql/202609172100_*`, `sql/2026091721??_answer_core`, `docs/answer-hub/`, จะแตะ server.mjs ด้วย) — ก่อนแก้ server.mjs ให้ re-read ก่อนเสมอ อย่าเขียนทับงานกัน

## DB migration

- `sql/202609172130_system_status.sql` — **ลงบนฐานท้องถิ่นแล้ว (2 รอบ ผ่านทั้งคู่)**
  - kind เพิ่ม 'worker_age' (drop/add constraint monitor_rule_kind_check)
  - กฎ 4 อัน: inbound/outbound-worker-warn/crit (1/5 นาที)
  - `inbox.health_thresholds()` + `inbox.health_queue()` (service_role เท่านั้น)
  - `health_snapshot` รุ่นใหม่ (เพิ่ม last_err) · `health_rule_save` รุ่นใหม่ (ตรวจค่า >= 1, hour_from < hour_to)
- **บน VPS ยังไม่ได้ลง** — ทำ `npm run sql:apply` (หรือรันไฟล์ตรง รันซ้ำได้) ตอน deploy

## API routes / UI route

- สาธารณะ: `GET /health` (503 เมื่อ down) · `GET /healthz`
- ล็อกอิน + manager/admin (ด่านใน SQL `health_can_view`): `GET /api/admin/system-health` · `POST /api/admin/system-health/test` (POST ตรวจ origin ด้วย)
- หน้าเว็บ: `/admin/health` · เมนู "สถานะระบบ" บนแถบหลัก (admin)

## Tests

```bash
npm run check                       # ✅ ผ่าน (syntax + ทะเบียน SQL)
node tests/http.integration.mjs     # ✅ รวม 68 ข้อ · ผ่าน 68
npm test                            # ✅ unit ทั้งชุดผ่าน (integration รวมอยู่ในนี้ด้วย)
```

หมายเหตุ: unit tests ผ่านหมด (ต่อให้ integration รันได้ = unit ก่อนหน้าผ่านทั้งหมด เพราะโซ่ &&)

### ข้อ 67 — แก้เสร็จแล้ว (2026-09-18) เก็บ root cause ไว้เป็นบทเรียน

อาการเดิม: `POST /api/admin/system-health/test` — เซลส์ → 403 ถูกต้อง · admin → **503** (body ไม่ใช่ JSON contract)

**root cause ตัวเดียว**: route ใน server.mjs ใช้ `const { steps } = await flowHealth.selftest()`
แต่ `selftest()` คืน **array ตรง ๆ** (ส่วนที่ห่อ `{steps}` คือ HTTP handler ของ health.mjs เอง อีกชั้นหนึ่ง)
→ destructuring ได้ `undefined` → `steps.filter` โยน TypeError ไม่มี `.status` → createServer catch → 503
เซลส์รอดเพราะโดน 403 ก่อนถึงบรรทัดนั้น · ข้อสงสัย (ข)/(ค) ปิดจบ — `getChannels` ถูกส่งให้ครบ
และทุก probe + extraSelfTests ถูกครอบ try แล้วจริง

แก้ไปสองจุด:
1. `server.mjs` (route) — เปลี่ยนเป็น `const steps = await flowHealth.selftest()` (ตัวเรียกโค้งตาม contract ของ selftest)
2. `tests/http.integration.mjs` ข้อ 67 — เดิมเช็ค secret หลุดด้วย `r.body.includes(...)` แต่ `r.body` ของ fetch
   Response เป็น ReadableStream ไม่ใช่ string (**บั๊กแฝง — ไม่เคยถูกใช้จริงเพราะ `&&` ชอร์ตซีร์กิตตรง 503**)
   → เปลี่ยนเป็น `JSON.stringify(body).includes(...)` ตามรูปแบบของข้อ 64

บทเรียน: 503 จาก createServer catch = error หลุดโดยไม่ตั้งใจเสมอ — ให้อ่าน log `request_failed` เป็นอย่างแรก

## Known limitations

- version จะแสดง `—` จนกว่าจะตั้ง `APP_VERSION` ใน .env (เพิ่มให้แล้วที่ .env.example? — ยัง ให้เติมเอง)
- overall ใช้แคช 15 วินาที — แก้กฎแล้วสถานะใหม่มาช้าไม่เกินรอบเดียว
- กฎ worker_age ไม่ยิง Telegram เอง (DB ไม่เห็นอายุ worker) — ครอบด้วยกฎ rpc-fail/gateway-fail เดิมแทน
- self-test ของเทสต์ server จะ FAIL ที่ขั้น TLS/token เพราะ localhost ไม่มีใบรับรอง + token ปลอม — เป็นพฤติกรรมถูกต้อง
- หน้า /admin/health ยังใช้ Supabase password grant ตรง (แยกจากเซสชันคุกกี้ของหน้าจอทีม) — ทำงานได้ แต่อนาคตอาจรวมเป็นเซสชันเดียว

## How to run

```bash
npm run sql:apply        # ลง migration (รันซ้ำได้)
npm run check            # syntax + ทะเบียน SQL
npm test                 # ชุดเต็ม
node tests/http.integration.mjs   # เฉพาะ integration (ต้องมี docker supabase ขึ้นอยู่)
node --env-file=.env server.mjs   # บูตจริง แล้วเปิด /admin/health ด้วยบัญชี admin
```

## How to rollback safely (ห้าม git reset --hard / checkout ทั้งไฟล์)

1. Migration ฝั่ง DB: ตัวใหม่เป็น "create or replace ทับรุ่นใหม่" ล้วน — ถอยด้วยการรันไฟล์
   `202609172025_health.sql` ซ้ำ (คืน health_snapshot/health_rule_save รุ่นเดิม) + drop เฉพาะ
   `health_thresholds/health_queue` + disable กฎ worker_age 4 อัน (อย่า drop constraint กลับ ถ้าไม่จำเป็น)
2. ฝั่ง Node: revert เฉพาะ hunk — สอง endpoint ใน route() · health() field ที่เพิ่ม · บล็อก computeSystemStatus..systemExtraTests · opts ใน createHealth · sysTimer — แก้จุดต่อจุด (ไฟล์มีงาน answer-hub ปนอยู่)
3. อย่าแตะ `sql/202609172025_health.sql` หลังลงแล้ว (ทะเบียน sha ใน inbox.sql_applied จะฟ้อง)

## Next phase (ตามลำดับ)

1. ลง VPS — **แผนฉบับรันได้อยู่ที่ `docs/handoff/2026-09-18-deploy-health-ah3.md`** (ผู้ใช้อนุมัติ deploy แล้ว · backup ทำแล้ว · ลงเฉพาะ 5 migration ทีละไฟล์ผ่าน docker exec psql **ห้าม sql:apply เต็มชุด** — ทะเบียน VPS มีแค่ 8 ไฟล์ ยิงซ้ำทั้งกอง) · หลัง deploy แล้วค่อยตั้ง UptimeRobot ยิง `/healthz` + เติม HEALTH_TELEGRAM_* (กลุ่มแยกจากทีมขาย)
2. ทดสอบหน้าจอในเบราว์เซอร์จริงกับข้อมูลโปรดักชัน (login admin → ปุ่มตรวจ → แก้กฎหนึ่งค่า → refresh → คืนค่า)
3. (แยกงาน) รวม login ของหน้า /admin/health เข้ากับเซสชันคุกกี้ของระบบ — **โค้ดเสร็จ + เทสต์ 72/72 แล้ว แต่ deploy ค้าง**
   ดูฉบับเต็มที่ `docs/handoff/2026-09-18-admin-health-ui-integration.md` (รอบแรก rollback เพราะ
   server.mjs พา import ของ answer-hub Phase 5-6 ไปโดยไม่มี services/ + COPY — ต้องสแกน import
   ทั้งไฟล์ก่อนส่งทุกครั้ง)
