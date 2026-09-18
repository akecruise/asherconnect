# Admin System Status — หน้าสถานะระบบสำหรับผู้ดูแล

หน้าเดียวที่ admin เปิดแล้วเห็นสถานะ ASHER Connect ทั้งระบบ กดทดสอบเองได้ และปรับเกณฑ์เตือนได้
ทุกตัวเลขมาจาก backend จริง (ฐานข้อมูล + โพรเซส) **ไม่มีข้อมูล mock และหน้าเว็บไม่คำนวณสถานะเอง**

- **URL:** `/admin/health` (ตามสถาปัตยกรรมเดิมของระบบ)
- **เมนู:** "สถานะระบบ" บนแถบเมนูของหน้าจอทีม — แสดงเฉพาะ admin (การซ่อนปุ่มเป็นความสะอาดตา
  ด่านจริงอยู่ที่ `inbox.health_can_view()` ในฐานข้อมูล)
- **ใครเข้าได้:** manager ดูได้ · admin ดูและแก้กฎได้ · sales/senior_sales โดนบล็อกที่ SQL (42501)

## Overall Status คำนวณอย่างไร

ตัวคำนวณอยู่ฝั่ง server (`systemStatus` ใน server.mjs) สรุปผลทุก 15 วินาที และส่งคำตอบเดียวกัน
ให้ทั้ง `/health` และหน้า admin:

| สถานะ | เกิดเมื่อไหร่ |
|---|---|
| **DOWN** | ฐานข้อมูลตอบไม่ได้ หรือ inbound worker เงียบเกินเกณฑ์ critical — ข้อความลูกค้าหายแน่ ๆ (`/health` ตอบ 503) |
| **DEGRADED** | บางส่วนผิดปกติแต่ยังให้บริการได้: ช่องทางไหน down, worker ขาออกเงียบ (นอกโหมดเงา), worker เข้าเกณฑ์เตือน, คิวค้างเกินเกณฑ์ |
| **HEALTHY** | ทุกชิ้นส่วนที่สำคัญยังเดิน |
| **UNKNOWN** | เพิ่งบูต ยังไม่จบรอบคำนวณแรก (ไม่เกิน ~2 วินาที) |

★ ช่องทางที่ "ไม่มีข้อความเข้า" **ไม่ใช่** ความเสียหาย — ลูกค้าอาจแค่ไม่ได้ทัก
หน้าจอจึงแยก `enabled` (ตั้งค่าไว้) / `reachable` (ต่อถึง) / `lastWebhookAt` (ข้อความล่าสุด) ให้ดูเป็นสามเรื่อง

## ส่วนประกอบของหน้า

| การ์ด | ที่มาของตัวเลข |
|---|---|
| ช่องทางขาเข้า (LINE / Messenger) | `channelStates` — ถาม token กับ LINE/Meta + เวลาข้อความล่าสุดจากฐาน |
| Gateway / TLS | ตัวเช็คยิงออกโดเมนจริงกลับเข้า Caddy ทุกนาที · วันหมดอายุใบรับรองทุกชั่วโมง |
| ฐานข้อมูล | ยิง `health_ping` จริงวัด latency (ไม่ใช่ดูว่าพอร์ตเปิด) |
| Inbound / Outbound Worker | เวลาสำเร็จล่าสุดของสองคิว เทียบกับเกณฑ์ในตารางกฎ |
| Queue | นับจาก `connect_private.job` ที่มีอยู่ (pending/processing/failed/อายุงานเก่าสุด) |
| Shadow Mode | สวิตช์ส่งจริง — เปิด = รับเข้าอย่างเดียว ไม่ส่งออกหาลูกค้า |
| กฎการเตือน · เหตุการณ์ล่าสุด | ตาราง `inbox.monitor_rule` + `inbox.flow_event` |

## Run Self-Test

ปุ่ม "ตรวจทุกขั้นตอนนี้" → `POST /api/admin/system-health/test` ทดสอบจริงทุกชั้น:
Gateway → ฐานข้อมูล → ใบรับรอง TLS → token ของ LINE/Meta (ถามเจ้าของ token ตรง ๆ ไม่ส่งอะไรถึงลูกค้า)
→ Inbound/Outbound Worker → Queue → Shadow Mode → ตัวแปรที่จำเป็น
ผลเป็น `PASS/FAIL` ต่อข้อ พร้อมเวลาที่ใช้ — **ไม่มีค่า secret กลับมาในคำตอบเด็ดขาด**
(ตัวแปรรายงานแค่ configured/missing; การแจ้งเตือน Telegram ยังไม่ตั้งค่า = ผ่านพร้อมหมายเหตุ)

## Health Rules (ปรับเกณฑ์ได้)

admin แก้จากหน้าเว็บได้ทันที (มีผลรอบคำนวณถัดไป ไม่ต้อง restart):

| กฎ | ค่าเริ่มต้น (เตือน/วิกฤต) | แปลว่า |
|---|---|---|
| inbound-worker-warn / -crit | 1 / 5 นาที | inbound worker เงียบนานขนาดนี้ = ผิดปกติ |
| outbound-worker-warn / -crit | 1 / 5 นาที | เฉพาะนอกโหมดเงา (โหมดเงาไม่นับเป็นเงียบ) |
| pending-warn / pending-urgent | 3 / 10 นาที | คิวตอบกลับค้างเกินนี้ = เสื่อม/วิกฤต |
| line-oa-silence / messenger-silence | 60 / 180 นาที (06:00–24:00) | ไม่มีข้อความเข้าในช่วงเปิดร้าน |
| reply-fail, token-fail, signature-fail, rpc-fail, gateway-fail, tls-expiry, telegram-fail | ดูในหน้าเว็บ | ความล้มเหลวรายจุด (นับครั้งในหน้าต่างเวลา) |

ค่าที่ใส่ผ่านการตรวจก่อนเขียนเสมอ: ตัวเลขต้อง >= 1 และช่วงเวลาต้องเรียงถูก (`hour_from < hour_to`)

## API

| เส้นทาง | สิทธิ์ | ใช้ทำ |
|---|---|---|
| `GET /health` | สาธารณะ (ใช้โดย docker healthcheck + uptime monitor) | สถานะรวมย่อ + ของเดิมครบ (ok, workerLastSuccess, memory, bot) |
| `GET /healthz` | สาธารณะ | ประตูให้ UptimeRobot — ตรวจ DB จริง ตอบ 200/503 |
| `GET /api/admin/system-health` | ล็อกอิน + manager/admin (ด่านใน SQL) | สถานะเต็มทุกคอมโพเนนต์ + กฎ + เหตุการณ์ |
| `POST /api/admin/system-health/test` | เดียวกัน + ตรวจ origin | รัน self-test คืน `{ ok, passed, failed, tests[] }` |
| `GET /api/health/snapshot` | Bearer token + manager/admin | ข้อมูลดิบของหน้า (stats/rules/events) |

## Troubleshoot

- **DOWN:** ดูการ์ดฐานข้อมูลก่อน (ตารางล่ม = ตายที่ Supabase) · ถ้า inbound worker down แต่ฐานปกติ
  ดู log ของ container (`docker logs asher-connect`) หา `inbound_worker_failed`
- **DEGRADED จากช่องทาง:** การ์ดช่องทางจะบอกเหตุผล (token ใช้ไม่ได้ / ข้อความหยุดนาน) — token ตายต้องไปหมุนที่ LINE/Meta
- **DEGRADED จากคิว:** งานค้างใน `connect_private.job` — `select kind,status,count(*) from connect_private.job group by 1,2`
- **HEALTHY แต่ลูกค้าบอกว่าบอทไม่ตอบ:** ดูสวิตช์บอทบนหัวหน้าจอทีม + โหมดเงา + กฎ "ไม่มีข้อความเข้า"

## หน้าจอ

Responsive ทั้ง desktop/tablet/mobile — desktop เป็น grid ห้าคอลัมน์, จอแคบลงเหลือสอง/หนึ่งคอลัมน์
ข้อมูลรีเฟรชเองทุก 30 วินาที (และมีปุ่ม "รีเฟรช" โหลดใหม่โดยไม่รีโหลดหน้า)
