# ASHER Answer Knowledge Hub

## Purpose

สร้าง "คลังคำตอบกลาง" (Answer Knowledge Hub) สำหรับ ASHER Connect — ฐานเดียวที่ทั้ง
พนักงานขาย (Quick Answer), บอท, และ Admin ใช้ร่วมกัน พร้อมระบบครบ: หมวดหมู่, Intent,
Version, Approval, Learning จากแชตจริง, Import, Search/Recommendation, Live Data Binding
กับ ERP, Usage/Feedback, Audit Trail

ท่อหลักของระบบ:

```
Customer Question
→ Intent Detection
→ Answer Knowledge Hub
→ ERP Live Data Resolver
→ Recommended Answer
→ Human หรือ Bot
→ Usage / Feedback
→ Learning
→ Review
→ Knowledge Improvement
```

หลักสำคัญ: **คนและบอทใช้ฐานคำตอบชุดเดียวกัน แต่สิทธิ์ต่างกัน** — บอทใช้ได้เฉพาะคำตอบที่
`status='approved'` + `audience ∈ (bot, both)` + `bot_auto_answer=true` + อยู่ในวันที่ valid
+ resolve ข้อมูล live สำเร็จเท่านั้น ถ้าไม่ครบทุกข้อ → ส่งต่อมนุษย์เสมอ ห้ามเดา

## Business Problem

ปัจจุบัน (ตรวจจาก AUDIT.md):
- ความรู้ของบอทเป็น static markdown (`bots/project-data/*.md`) — แก้ได้เฉพาะ dev, ไม่มี
  version, ไม่มี approval, คนขายมองไม่เห็น
- คนขายมี Quick Reply (template สำเร็จรูป) แยกกัน — ไม่เชื่อมกับข้อมูลบอท ไม่มีคำตอบแบบ
  dynamic (ราคาจริงจาก ERP, โปรโมชั่นจริง)
- คำตอบดี ๆ ที่คนขายพิมพ์เองหายไป — ไม่มีระบบจับกลับมาเป็นความรู้
- ราคา/โปรโมชั่น/ห้องว่างมีอยู่จริงใน ERP (`inventory.unit`, `public.promotions`) แต่ไม่มีระบบ
  ไหนดึงมาตอบลูกค้าอัตโนมัติ

## Architecture

สรุป: ดู `ARCHITECTURE.md` · รายงานของเดิมฉบับเต็ม: `AUDIT.md`

- Schema ใหม่ทั้งหมดใน `answer_hub` (PostgreSQL, self-hosted Supabase เดิม)
- Service layer ใหม่: `services/answer-hub/*.mjs` (Node ฝั่ง server.mjs)
- API เข้าทางประตูเดิม `POST /api/command {action, data}` → RPC `inbox.ah_*`
  (security definer, ตรวจ role ใน SQL, whitelist ใน Node)
- บอทใช้ผ่าน worker RPC เท่านั้น ห้าม SQL ตรง
- Frontend: vanilla JS + CSP 'self' ตามประตูเดิม (ไม่มี CDN, ไม่มี inline script), UI ไทย

## Main Components

| Component | ที่อยู่ | สถานะ |
|---|---|---|
| Database schema `answer_hub` | `sql/YYYYMMDDHHMM_*.sql` | Phase 1–5, 11, 16, 17 |
| Answer Service (Node) | `services/answer-hub/` | Phase 6 |
| Quick Answer UI (คนขาย) | `public/` (composer) | Phase 13 |
| Admin UI "คลังคำตอบ" | `public/answer-hub*` | Phase 8–10, 12 |
| Recommendation Engine | SQL + `services/answer-hub/` | Phase 14 |
| Bot bridge | `services/answer-hub/bot-bridge.mjs` | Phase 15 |
| Learning | hook ที่ human_reply/inbound + Learning Queue | Phase 11–12 |
| ERP Sources | `answer_hub.source_registry` + resolver | Phase 4–5 |
| Feature flags | env + `inbox.settings` | Phase 29 |

## Database

รายละเอียดทุกตาราง: `DATABASE.md` — หลักการ:

- ไฟล์ migration ใหม่ `YYYYMMDDHHMM_<task>.sql` ต่อท้าย `sql/ORDER.txt` เท่านั้น
- **ห้ามแก้/rerun migration เก่า** (incident 032 — ดู AUDIT.md §8)
- ทุกไฟล์ idempotent, RLS on + revoke + grant execute เฉพาะฟังก์ชัน (ตาม pattern health)
- Quick Reply เดิมเป็นของ repo `asher-web` — hub ผูกผ่าน link table ฝั่ง `answer_hub` ไม่ ALTER ตารางเดิม

## Admin

หน้า Admin → คลังคำตอบ (Phase 8): Dashboard, คำตอบทั้งหมด, เพิ่มคำตอบ, Import,
Learning Queue, หมวดหมู่, Intent, ERP Sources, Versions, Usage, Feedback, Health
คู่มือ: `ADMIN-GUIDE.md`

## Quick Answer

สำหรับคนขายใน composer (Phase 13): Search, Suggested, Categories, Recent,
Frequently Used, Recommended — Preview/Edit/Send/Favorite/Submit to Knowledge/
Report Incorrect คู่มือ: `SALES-GUIDE.md` · Quick Reply เดิมใช้ต่อได้ 100% (legacy
items ที่ไม่มี link ทำงานเหมือนเดิมทุกอย่าง)

## Learning

Shadow learning (Phase 11): ลูกค้าถาม → คนตอบ → เก็บ candidate → Admin รีวิว →
Approve สร้าง answer_item (bot_auto_answer=false เสมอตอนเกิด) — ห้าม auto-learn
auto-send โดยไม่ผ่านคน คู่มือ: `LEARNING-GUIDE.md`

## Bot

บอทใช้คำตอบจาก hub เป็น "ลำดับแรก" (approved + bot เท่านั้น) ไม่เจอค่อย fallback
Claude generation แบบเดิม; required data ขาด → ไม่เดา → ส่งมนุษย์
คู่มือ: `BOT-GUIDE.md` · เหตุผลเชิงเทคนิค: `adr/ADR-002-no-direct-bot-sql.md`

## ERP Live Data

ผูกของจริง 4 แหล่ง (ตรวจ live DB แล้ว — ดู AUDIT.md §4.3):
`core.project`, `inventory.unit` (ราคา/สถานะ), `public.promotions`,
`public.project_facts` — ที่เหลือเป็น placeholder inactive
เรียงความสำคัญ: ERP Live > Approved Manual > Approved Learned > Imported > AI Draft

## Security

`SECURITY.md` — สรุป: ไม่ expose service_role/secret/token, role ตรวจใน SQL เสมอ
(UI แค่ cosmetc), RLS deny-all + grant เฉพาะฟังก์ชัน, ห้าม SQL arbitrary จาก bot,
import ต้อง validate ทุกแถว, health ของ hub อยู่หลัง gate ของ `/admin/health` เดิม

## Development Phases

30 Phases — ตารางเต็ม: `ROADMAP.md` · Dashboard: `PHASE-STATUS.md`
สรุป: 0 Audit → 1 Database → 2 Answer Core → 3 Version → 4 Source Registry →
5 Binding → 6 Services → 7 QR Integration → 8 Admin → 9 Add/Edit → 10 Import →
11 Learning → 12 Learning Review → 13 Quick Answer → 14 Recommendation →
15 Bot → 16 Usage → 17 Feedback → 18 Permissions → 19 Security → 20 Health →
21 Logging → 22 Tests → 23 Manual Test → 24 Dashboard → 25 Docs → 26 Deploy →
27 Rollback → 28 Troubleshooting → 29 Flags → 30 Acceptance

## Current Status

**Phase 0 (Discovery & Audit): COMPLETE** — รายงาน: `AUDIT.md`
ต่อไป: Phase 1 Database Foundation (migration `answer_hub` ชุดแรก)

## How to Continue

1. อ่าน `HANDOFF.md` ก่อนเสมอ — มี `SAFE NEXT COMMAND:` บอกจุดเริ่มที่แท้จริง
2. เช็ค `PHASE-STATUS.md` ว่า Phase ไหนอยู่ตรงไหน
3. ทำงานเสร็จแต่ละ Phase → update ทั้ง 4 ไฟล์: ROADMAP / PHASE-STATUS / HANDOFF / CHANGELOG
4. Test: `npm run check` + `npm test` ต้องผ่านก่อนจบทุก Phase

## Related Files

- `AUDIT.md` — ผลสำรวจระบบเดิม (อ่านก่อนแก้โค้ดใด ๆ)
- `ARCHITECTURE.md`, `DATABASE.md`, `API.md` — การออกแบบ
- `adr/` — Architecture Decision Records
- โค้ดเดิมที่เกี่ยว: `server.mjs`, `bots/reply.mjs`, `public/app.js`, `public/quick-replies*`,
  `sql/ORDER.txt`, `sql/run.mjs`, `health/`
- repo คู่แฝด: `D:\aplus_postgres_docker\asher-web` (เจ้าของ Quick Reply migrations)
