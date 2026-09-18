# HANDOFF — รวมหน้า /admin/health เข้า UI หลัก (โค้ดเสร็จ · deploy ค้าง) (2026-09-18)

> **สถานะ: โค้ด + เทสต์เสร็จสมบูรณ์ แต่ยังไม่อยู่บนโปรดักชัน** — deploy รอบแรกล้มและ rollback แล้ว
> prod ปัจจุบัน = เวอร์ชันเช้า `2026.09.18-health-ah3` (หน้า /admin/health ยังเป็น standalone)
> agent ถัดไปเริ่มที่หัว "ทางเดินต่อ" ท้ายไฟล์นี้ได้ทันที

## งานนี้ทำอะไร (ตามสเปกผู้ใช้ 12 ข้อ)

เลิกหน้า login/layout standalone ของระบบเช็ค — /admin/health ใช้เปลือกเดียวกับแอปหลัก
(sidebar/header/profile/logout/CSS เดิม) · anonymous → ฟอร์มล็อกอินเดิมบน URL เดียวกัน →
ล็อกอินแล้วกลับมาหน้าเดิม · manager/admin เห็น · sales โดนด่าน `health_can_view` ตามเดิม ·
เมนู "สถานะระบบ" แสดงเฉพาะ manager/admin · หน้ามี 3 ส่วน: ภาพรวม / ตรวจทุกขั้น / กฎแจ้งเตือน

## ไฟล์ที่แก้ (ท้องถิ่น — ยังไม่ขึ้น prod)

| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `server.mjs` | ① route(): preempt `GET /admin/health` → เสิร์ฟ index.html (แทนที่ flowHealth.handle ที่ชิงไปเสิร์ฟ health.html standalone) ② endpoint ใหม่ `POST /api/admin/health-rule` (เซสชันคุกกี้ → `health_can_view` ด่านหน้า · ด่านแก้ = admin-only อยู่ใน `health_rule_save` ใน SQL · `health_tick` **ต้องยิงด้วย `service` key** ไม่ใช่ token ผู้ใช้ — ยิงผิดแล้วตอบ 403 ทั้งที่ save สำเร็จ) |
| `public/app.js` | `ADMIN_VIEW` branching ใน start() (ไม่โหลดของแชท/ไม่ poll) · โมดูลหน้าสถานะระบบ (`buildAdminHealth/renderAdminHealth/renderAdminRules/runAdminSelfTest/onAdminRuleChange`) สร้าง DOM เข้า `#workspace main` ตอน runtime (ไม่แตะ index.html มินิไฟด์) · `wireAppNav` เมนู = manager+admin (เดิม admin) · login handler `location.replace(ADMIN_VIEW?'/admin/health':'/')` |
| `public/app.css` | บล็อกท้ายไฟล์: `body.admin-view` (ซ่อน .queue/.conversation/#lead-card) + คลาส `ah-*` + `.pill.good/.warn/.gray` — สีทุกสีมาจาก `:root` ตามกติกาไฟล์ (โหมดมืดถูกเอง) |
| `tests/http.integration.mjs` | เพิ่มข้อ **69** (หน้าเสิร์ฟเปลือกหลัก ไม่มี standalone), **70** (admin + เซสชันเดิมเห็นเปลือก), **71** (manager ดู 200 · บันทึกกฎโดนปฏิเสธ 4xx), **72** (admin บันทึกผ่านเซสชัน → อ่านใหม่ค่าคงอยู่ → คืนค่า) — ไม่ลบ/ข้ามข้อเดิม |

**สัญญาที่คงไว้ (ห้ามพัง):** `POST /api/admin/system-health/test` → `const steps = await flowHealth.selftest()`
คืน **array** · endpoints เก่า `/api/health/*` ของ health.mjs ยังอยู่ครบ (เทสต์ 68 ใช้อยู่) · health.mjs **ไม่ถูกแก้แม้บรรทัดเดียว**

## ผลเทสต์ (state ที่ตรึง)

- `npm run check` ผ่าน · unit **178 fail 0** · integration **72/72**
- sha ของ state ที่ผ่าน 72/72: `server.mjs` = `322884b5…` · `public/app.js` = `15de319a…` ·
  `public/app.css` = `78433aef…` — **ถ้า sha ปัจจุบันไม่ตรง = มีคนแตะท้องถิ่นหลังจากนี้ ให้รัน pre-flight ใหม่ทั้งชุดก่อน deploy เสมอ**
- บั๊กที่เจอระหว่างทางและแก้แล้ว: health_tick ด้วย token ผู้ใช้ → 403 (แก้เป็น service key ตามด้านบน)

## เหตุที่ deploy รอบแรกล้ม (2026-09-18 ~08:00)

ส่งเพียง 3 ไฟล์ (server.mjs + public/app.js + app.css) → container **restart loop**:
`ERR_MODULE_NOT_FOUND: /app/services/answer-hub/service.mjs`
**สาเหตุ:** session answer-hub แตะ `server.mjs` ระหว่างทาง (ตอนนั้นทำ Phase 5–6 — AH_ACTIONS โตเป็น 12
action + import `./services/answer-hub/service.mjs`) — import นี้ไม่มีทั้งไฟล์บน VPS และไม่มี
`COPY services` ใน Dockerfile
**จัดการแล้ว:** restore จาก `/opt/asher-inbox/backup-ui-health-20260918/` (server.mjs/app.js/app.css
เวอร์ชันเช้า) → rebuild → **healthy กลับมา restarts=0 · logs สะอาด** · prod ยืนยันแล้ว: /healthz 200 ·
/health healthy

## บทเรียน (ห้ามลืม)

1. **ก่อนส่ง server.mjs ขึ้น VPS ต้องสแกน import ทั้งไฟล์** เทียบกับสิ่งที่มีบน VPS + Dockerfile COPY
   ทุกครั้ง — "ส่งเฉพาะของตัวเอง" เป็นไปไม่ได้เมื่อ session คู่ขนานปนไฟล์เดียวกัน
2. sha-check กัน race ได้จริง: ตรึง sha หลังเทสต์ → เทียบก่อนอัป → เทียบปลายทางหลังอัป — รอบหน้าทำเหมือนเดิม
3. backup ก่อนแก้ทุกไฟล์บน VPS — รอบนี้ rollback จบใน ~1 นาทีเพราะมี backup รายไฟล์

## ทางเดินต่อ (เริ่มตรงนี้)

1. **ผู้ใช้หยุด/ฟรีซ session answer-hub ให้นิ่งจริง** (รอบนี้มันกลับมาแตะ server.mjs อย่างน้อย 3 ครั้ง:
   Phase 4 ปิด 05:38 · Phase 5 ปิดช่วงเช้า · Phase 6 07:39)
2. สแกน import ของ `server.mjs` ทั้งไฟล์ (`grep -n "^import\|from '\./" server.mjs`) → เทียบกับ
   `/opt/asher-inbox/app` และ `Dockerfile` → ส่งไฟล์พึ่งพาให้ครบ (น่าจะต้องเพิ่ม `services/` ทั้งโฟลเดอร์
   + `COPY services ./services` ใน Dockerfile) — อย่าลืมกติกาเดิม: ลืม COPY = boot ไม่ขึ้นเลย
3. pre-flight ใหม่ทั้งชุดบน state สุดท้าย: check + unit (fail ต้อง 0) + integration (ต้อง 72/72 ขึ้นไป)
4. backup ไฟล์ที่จะแก้บน VPS ก่อนอัป (แบบเดียวกับ backup-ui-health-20260918) · sha เทียบก่อน-หลัง ·
   ห้ามแตะ `.env`/`channels.json` · **ไม่มี migration ในงานนี้ — ห้ามแตะ database**
5. `docker compose build && up -d` → healthy → smoke ตาม PHASE 6-7 ใน
   `2026-09-18-deploy-health-ah3.md` (รวม session จริงด้วยบัญชีบริการบนเครื่อง VPS —
   **ห้ามพิมพ์/แสดง secret**) → ผู้ใช้ทดสอบเบราว์เซอร์: login → Admin → สถานะระบบ → ตรวจทุกขั้น →
   แก้กฎ 1 ค่า → save (มี confirm) → refresh ค่าคงอยู่ → คืนค่า
6. **known limitation ที่ต้องแจ้ง:** actions ของ answer-hub Phase 4/5/6 (`ah_source_*`, `ah_resolve`,
   `ah_binding_*` ฯลฯ) จะ error อย่างมีระเบียบจนกว่าจะลง migration ของมัน — แยกงานตามที่ผู้ใช้กำหนด
   (งาน UI ไม่แตะ DB) · `HEALTH_TELEGRAM_*` + UptimeRobot ยังไม่ตั้งตามสเปก

## เชื่อมโยง

- แผน deploy + กฎ 12 ข้อ + เหตุการณ์ rollback ฉบับเต็ม: `docs/handoff/2026-09-18-deploy-health-ah3.md`
- ระบบเช็คฝั่ง backend: `HEALTH-CHECK-HANDOFF.md` (root) · `docs/admin-system-status.md`
- ทะเบียนงาน answer-hub (session คู่ขนาน): `docs/answer-hub/HANDOFF.md`

---

## ✅ TASK 1 COMPLETE — ตรวจยืนยันหลัง rollback (2026-09-18 ~01:20Z)

ตรวจครบ 7 ข้อบนโปรดักชันจริง (อ่านอย่างเดียว) ผ่านหมด:

| ข้อ | ผลตรวจ |
|---|---|
| 1. Rollback สมบูรณ์ | ✅ sha ไฟล์บน prod = backup ทุกไฟล์: server.mjs `0143fb15…` · app.js `d804c93c…` · app.css `13abf273…` |
| 2. Container เสถียร | ✅ running · healthy · **restarts=0** (เริ่ม 2026-09-18T00:52:12Z · uptime 1487 วินาที ณ ตรวจ) |
| 3. /healthz | ✅ 200 `{"ok":true,"uptime_s":1487}` |
| 4. /admin/health | ✅ 200 — ยังเป็นหน้า standalone (มีฟอร์มล็อกอินของตัวเอง) = ถูกต้องตามสภาพ rollback |
| 5. .env / channels.json | ✅ ไม่ถูกแตะ — .env mtime 1789688724 (หลัง append APP_VERSION ตอนเช้า ไม่มีการแก้ต่อ) · channels.json 1789608065 (คงเดิมทั้งวัน) |
| 6. เวอร์ชัน/image | ✅ APP_VERSION=`2026.09.18-health-ah3` · status=healthy · image `sha256:fe0b7fa2ee7…` (build หลัง rollback) |
| 7. Boot errors | ✅ 0 — 30 นาทีล่าสุด (ครอบ boot หลัง rollback): ไม่มี ERR_MODULE_NOT_FOUND/TypeError/FATAL/request_failed/Unhandled |

### สถานะโปรดักชันที่เสถียร ณ ปิด TASK 1 (exact stable state)

```
host:      187.53.139.175 · /opt/asher-inbox/app · container asher-connect
state:     running · healthy · restarts=0 · started 2026-09-18T00:52:12Z
version:   APP_VERSION=2026.09.18-health-ah3 (/health → version ตรง · status=healthy)
image:     sha256:fe0b7fa2ee7… (app-asher-connect, build หลัง rollback จาก backup-ui-health-20260918)
files:     server.mjs 0143fb15… · public/app.js d804c93c… · public/app.css 13abf273… (= backup เป๊ะ)
behavior:  /admin/health ยังเป็นหน้า standalone (ล็อกอินแยกด้วย password grant) — โค้ด UI รวมใหม่
           (app.js/app.css/server.mjs เวอร์ชัน 72/72) ยังอยู่แค่ท้องถิ่น รอ TASK 2
migrations: 5/5 ตามทะเบียน inbox.sql_applied (ไม่มีการแตะ DB เพิ่มในรอบ rollback)
```

**TASK 2 (ยังไม่เริ่ม):** deploy โค้ด UI รวม — ประตูผ่านคือ session answer-hub ต้องนิ่ง + สแกน import
ทั้งไฟล์ก่อนส่ง (ข้อมูลล่าสุด ณ หยุด TASK 1: import ทั้งหมดของ server.mjs อยู่ใน bots/ lib/ reports/
health/ services/ + root 4 ไฟล์ และ Dockerfile มี `COPY services ./services` แล้ว · sha ชุด 72/72
ท้องถิ่นยังตรง: server.mjs `322884b5…` · app.js `15de319a…` · app.css `78433aef…`)
