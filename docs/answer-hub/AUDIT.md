# AUDIT — Phase 0 Discovery & Audit (Answer Knowledge Hub)

ผลสำรวจระบบจริง ณ วันที่ 2026-09-17 ก่อนเขียนโค้ดใด ๆ ตามกฎข้อ 1 ของ Master Command
ตรวจจาก 3 แหล่ง: (1) อ่านโค้ดทั้งหมด, (2) อ่าน migration ใน `sql/` + repo คู่แฝด `asher-web`, (3) สอบถาม live database
ผ่าน PostgREST OpenAPI + psql catalog ของ Supabase stack ที่รันอยู่ (docker `supabase-db`)

---

## 1. ระบบคืออะไร (ภาพรวม)

ASHER Connect = อินบ็อกซ์แชตลูกค้า (ภาษาไทย) ของโครงการบ้าน/คอนโด 2 โครงการ:
**ASHER Naii (อินทามระ 41)** และ **ASHER Vibe (อินทามระ 21)** (`core.project` มี 2 แถวจริง)

- รับ webhook จาก **LINE + Messenger** → ตรวจ HMAC signature → เก็บ raw event → ประมวลผลในคิว
- **ตรรกะการตัดสินใจของบอทอยู่ใน PostgreSQL ทั้งหมด** (`sql/002_decide.sql`: decide_reply/notify/delay/watchdog อ่าน `inbox.bot_config` + `inbox.bot_schedule`)
- คำตอบบอทสร้างด้วย **Claude (claude-haiku-4-5-20251001)** ใน `bots/reply.mjs` โดยยึดข้อเท็จจริงจากไฟล์ markdown ต่อโครงการ (`bots/project-data/naii.md`, `vibe.md`) — ★ นี่คือ "ฐานความรู้" ปัจจุบันของบอท: เป็น static file ไม่มี version, ไม่มี approval, คนขายมองไม่เห็น
- ทีมขายตอบเองผ่านเว็บอินบ็อกซ์ vanilla JS (`public/app.js`)
- Deploy: single container `asher-connect` (Node 22 alpine) บน VPS `187.53.139.175:/opt/asher-inbox/app` port 3200 (localhost) → Caddy → `inbox.apluscondo.com`
- Database: **self-hosted Supabase** (docker stack เดียวกันทั้ง local และ VPS) — `SUPABASE_URL=http://supabase-envoy:8000`, PostgREST v14.17 ที่ expose schemas `public, graphql_public, core, inbox`

## 2. สถาปัตยกรรมจริง (สิ่งที่ทุก feature ใหม่ต้องเข้ากับ)

```
browser (vanilla JS, CSP 'self' ไม่มี CDN, ไม่มี inline script)
  → POST /api/command {action, data}   ← ประตูเดียวของแอป (มี session cookie + checkOrigin)
    → server.mjs (Node) — dispatch เป็น 3 แบบ:
        a) rpcDirect(token, 'qr_list'|'stats_*'|'logs_*', …)  ← RPC เฉพาะชื่อ + whitelist Set ใน Node + ตรวจ role "ใน SQL"
        b) rpc(token, action, data) → PostgREST /rest/v1/rpc/connect_api {p_action,p_data} (profile inbox)
        c) edgeCall(name, …) → Edge Function ที่ลงทะเบียนไว้ใน CONNECT_EDGE_FUNCTIONS
  → Supabase Postgres (schema inbox / connect_private / core / crm / inventory / doc / public)
```

**ข้อสรุปเชิงออกแบบสำหรับ Answer Hub**: ฟีเจอร์ใหม่ยุคหลัง (stats, logs, health, quick reply) ใช้แบบ (a) — **RPC เฉพาะชื่อต่อ action + ตรวจ role ใน SQL + whitelist ใน Node** เพราะ `connect_private.api` ถูก overwrite ทับกันมาแล้ว 5 ครั้ง (incident 032: rerun ไฟล์เก่าทำ function หาย 15 ตัว ส่งข้อความตาย 37 นาที — บันทึกใน `docs/handoff/2026-09-16.md` และ `sql/ORDER.txt:95-104`) Answer Hub จะใช้ convention นี้: ฟังก์ชันชุด `inbox.ah_*` (security definer, role gate ข้างใน) เรียกผ่าน `rpcDirect` + whitelist `AH_ACTIONS`

## 3. Roles จริงที่มีอยู่ (ต่างจาก Master Command)

Master Command ระบุ Sales/Supervisor/Admin/Bot — **ของจริงคือ** (จาก `core.profile.role`, ตรวจ live DB: `admin, manager, sales, senior_sales`):

| Master Command | ของจริงในระบบ | สิทธิ์เดิม |
|---|---|---|
| Sales | `sales`, `senior_sales` | อ่าน+ตอบ+claim; QR: list ได้ แก้ไม่ได้ |
| Supervisor | `senior_sales` (จำกัดทีมเดียวกัน), `manager` (ทุกอย่างระดับ manager) | stats ดูได้, transfer ได้ |
| Admin | `admin` | ทุกอย่าง; QR upsert/toggle; logs; bot_switch/send_switch |
| Bot/System | `service_role` + worker path (`connect_worker`) | เขียนคิว/อ่าน context เท่านั้น |

→ Answer Hub จะยึด role จริง 4 ตัวนี้ ไม่สร้าง role ใหม่ (ADR-004)

## 4. Database objects ที่มีอยู่จริง (ตรวจ live catalog แล้ว)

### 4.1 Quick Reply (มีอยู่จริง — ห้ามลบ, migration อยู่ repo `asher-web`)
ไฟล์ต้นทาง: `D:\aplus_postgres_docker\asher-web\supabase\migrations\20260916154809_quick_reply.sql`
Live DB ตรวจแล้ว — ทุก object **มีจริง**:

| Object | Signature จริง | หมายเหตุ |
|---|---|---|
| `inbox.quick_reply` | project check(naii\|vibe\|all), category check(greeting\|rooms_price\|floorplan\|facilities\|location\|promo\|visit\|other), shortcut, title, body, send_order, intents text[], bot_enabled, confidence_min, sort_order, active, created_by/updated_by | ตาราง 0 แถว (ยังไม่มีข้อมูลจริง) |
| `inbox.quick_reply_attachment` | PK (quick_reply_id, position), media_asset_id | |
| `inbox.quick_reply_usage` | quick_reply_id, conversation_id, message_id, sent_by, matched_intent, confidence, edited_before_send | ★ ยังไม่มี caller ใน repo นี้ |
| `inbox.media_asset` | project, title, storage_path unique, mime, width/height/bytes | |
| `inbox.qr_list(p_project, p_query, p_category) → jsonb` | role gate sales…admin | ★ bug: filter `active` เสมอ หน้า admin เห็นแต่แถวที่เปิด |
| `inbox.qr_suggest(p_conversation_id) → jsonb` | scoring ตาม keyword/intent | ★ ยังไม่มี caller |
| `inbox.qr_toggle(p_id, p_active, p_bot_enabled) → jsonb` | role gate marketing\|manager\|admin | |
| `inbox.qr_upsert(p_data jsonb) → jsonb` | role gate เดียวกัน | |
| `inbox.qr_send(p_conversation_id, p_quick_reply_id, p_body_override, p_edited_before_send) → jsonb` | | ★ ยังไม่มี caller |

การเชื่อม Answer Hub ↔ Quick Reply ต้อง **ไม่แตะ migration ของ asher-web** — ดู ADR-005 (ใช้ link ในฝั่ง answer_hub)

### 4.2 Inbox core (มีจริงใน live DB)
`inbox.inbox, conversation (มี mode, is_test, last_*_reply_at, ad_id), message (มี media jsonb), contact, canned_response, bot_config, bot_schedule, bot_decisions, message_intents, human_reply_events, sales_staff(+identity, kpi_daily), conversation_outcomes, assignment_rule, media_asset, quick_reply*`
**สถานะ local dev DB**: มีเฉพาะชุด 001–009 + QR — ยังไม่มี `inbox.settings, sla_policy, response_window, flow_event, monitor_*, sql_applied` (ไฟล์ 016–037 + health ยังไม่ถูก apply ลง local; บน VPS apply มากว่านั้น — ตรวจด้วย `npm run sql:plan -- --db "<conn>"` ก่อน apply ทุกครั้ง)
ข้อมูลจริงใน local: conversation 7 / message 36 / profile 7 / lead 3 / promotions 1 — เป็นข้อมูล dev

### 4.3 ERP ของจริง (ใช้ทำ Source Registry ได้ทันที)

| Object จริง | Columns จริง | Map เป็น logical source |
|---|---|---|
| `core.project` | id, code, name, status, launch_at, extra | PROJECT_PROFILE |
| `inventory.unit` | project_id, unit_type_id, building, floor, number, **status, price**, held_by_doc | PROJECT_PRICE (min(price)), AVAILABLE_UNITS (count by status) |
| `public.promotions` | promotion_id, project_id, name, offer, landing_page, start_date, end_date, status | CURRENT_PROMOTION |
| `public.project_facts` | project_id, fact_key, value_text, value_num, unit, disclaimer, is_public, verified_at | PAYMENT_TERMS / PROJECT_LOCATION / FACILITIES (fact_key) — ★ ตารางยังว่าง |
| `crm.lead` (3 แถว) / `crm.activity` (ว่าง) | activity มี type='site_visit' ตาม spec | APPOINTMENT_SLOT / LEAD_PROFILE / LEAD_FOLLOWUP (case_state.follow_up_at) |

**สรุป**: ของจริงมีให้ map 4 แหล่ง (project, unit+price, promotions, project_facts) — ที่เหลือสร้าง placeholder inactive ตามกฎ "อย่าสร้าง fake data"

### 4.4 ไม่มีอยู่จริง (ยืนยันแล้ว — greenfield)
`answer_hub` schema: **ไม่มี** · knowledge/answers/FAQ/recommendation/learning/embedding/pgvector: **ไม่มีทั้ง repo** (มีเพียง `bots/reply.mjs:11` บอกเองว่า "no RAG — no knowledge table yet")

## 5. Flow ที่ต้อง integrate (ที่เดิม + จุด hook ของ Answer Hub)

| Flow | ที่อยู่เดิม | จุด hook Answer Hub |
|---|---|---|
| Inbound | `/webhooks/:key` → RPC `log` → `inboundWorker` (ทุก 3s) → `claim_inbound` → `receive_event` | หลัง `receive`: สร้าง learning candidate (Phase 11) — fire-and-forget ห้าม block |
| Bot reply | worker `generate` job → `reply_context` → `bots/reply.mjs generateReply` → RPC `bot_reply` | ก่อนยิง Claude: `recommendAnswers()` จาก Answer Hub ถ้าเจอ approved+bot_auto_answer → ใช้คำตอบจาก hub; ไม่เจอค่อย fallback Claude (Phase 15) |
| Human send | composer → `/api/command send` → `connect_private.api` action `send` → trigger `enqueue_outbound` → `connect_private.delivery` → `providers.deliver` | Quick Answer = แหล่งข้อความก่อนถึง composer (fill only); `recordUsage` ตอน send สำเร็จ (Phase 16) |
| Quick Reply เดิม | `bootstrap` embed `qr_list` (fallback `canned_response`); picker `quick-replies.js` fill `#message` เท่านั้น | Phase 7: เพิ่ม answer-hub items ใน bootstrap / ปุ่ม Quick Answer ใหม่ — ห้ามทำ QR เดิมพัง |
| Health | `health/health.mjs` + `inbox.flow_event` + `/admin/health` | เพิ่ม stage `answer_*` และ section ใน snapshot (Phase 20) |
| Logging | JSON stdout (`log.*`, event names รวมใน AUDIT นี้) + `flow_event` + `connect_private.audit` | เพิ่ม structured event ตาม Phase 21 ผ่าน `log.info` + `health.log` เท่าที่จำเป็น |

## 6. Components ที่ reuse ได้ (ไม่ต้องสร้างใหม่)

- **Dispatcher/rpcDirect + whitelist pattern** (`server.mjs:209-220`) — ต่อยอดเป็น AH_ACTIONS
- **Role gate ใน SQL + security definer `set search_path=''`** — pattern จาก `202609172025_health.sql`
- **Migration machinery**: `sql/run.mjs` (check/plan/apply + sha256 ledger + กันไฟล์แก้หลัง apply), ORDER.txt, convention ไฟล์ใหม่ `YYYYMMDDHHMM_<task>.sql` idempotent เสมอ
- **Frontend pattern**: staticFiles map (`server.mjs:1134`) + nav ใน index.html + DOM-API-only + ไทย + CSP-safe — ต่อยอดหน้า admin "คลังคำตอบ"
- **Search/recommend เริ่มต้น**: `inbox.qr_suggest` (asher-web) มี scoring แบบ keyword/intent อยู่แล้ว — เป็นแนวอ้างอิง แต่ Answer Hub จะสร้างของตัวเองใน answer_hub schema (pg_trgm ถ้ามี extension จริง)
- **Templates/variables**: composer มี template variable `{ชื่อ} {โครงการ} {ราคาเริ่มต้น}` ที่ "ห้ามเดาค่าที่ไม่มี" (`app.js:32-62`) — ปรัชญาเดียวกับ DATA PRIORITY RULE ของ hub

## 7. Missing components (ต้องสร้าง)

ทั้ง schema `answer_hub` (10 ตารางตาม Master Command), service layer `services/answer-hub/`, RPC `inbox.ah_*`, admin UI ใหม่, import (xlsx/csv), learning pipeline, recommendation engine, usage/feedback, feature flags, tests ชุดใหม่ — รายละเอียดใน ROADMAP.md

## 8. Risks ที่ค้นพบ (มีของจริง ต้องออกแบบหลบ)

1. **`connect_private.api`/`worker` ถูกทับซ้อนเป็นประวัติศาสตร์** — ห้าม emit ซ้ำ; ทุกฟังก์ชันใหม่ต้องตั้งชื่อใหม่ (`ah_*`) และไฟล์ migration ต้อง idempotent + มี guard หัวไฟล์แบบ 032–036
2. **apply ไฟล์เก่ารีเซ็ตของใหม่** — ห้าม rerun ไฟล์ 002/026 ฯลฯ; ใช้ `sql:plan` ก่อนเสมอ (ledger บน local ยังไม่มี → บน local ห้ามรัน apply ไฟล์เก่าเด็ดขาด)
3. **Quick Reply เป็นของอีก repo** (`asher-web`) — ALTER ตาราง `inbox.quick_reply` จาก asher-connect จะทำให้ความเป็นเจ้าของกำกวม → ใช้ตาราง link ฝั่ง answer_hub แทน (ADR-005)
4. **`GET /health` ไม่มี auth** (public) และ `/api/health/login` คืน Supabase access token ให้ browser — Answer Hub ห้ามเพิ่มข้อมูลอะไรลง endpoint เหล่านี้; ของ hub ใช้ระบบ snapshot ของ `/admin/health` ที่ gate ใน SQL แล้วเท่านั้น
5. **qr_list bug (filter active)** — หน้า admin ของ hub ห้ามทำ pattern เดียวกัน (ต้อง list ได้ทุกสถานะ + filter ด้วย parameter)
6. **Local dev DB ล้าหลัง VPS** — test ที่พึ่ง inbox.settings/flow_event จะ fail บน local จนกว่าจะ apply 016+ — Answer Hub ต้องไม่พึ่งตารางที่ local ยังไม่มี หรือต้อง apply ให้ครบก่อน (จัดลำดับใน Phase 1)
7. **CSP 'self' เข้มงวด** — ห้าม CDN, ห้าม inline script/style; import xlsx ต้องเป็น lib ที่ bundle ไว้ใน repo ได้ (หรือ parse ฝั่ง server ด้วยโค้ดใน repo)
8. **ข้อมูล ERP บางส่วนว่างจริง** (project_facts ว่าง, crm.activity ว่าง, unit 0 แถวใน local) — dynamic answers ต้องมี fallback text + ห้ามเดา (แนวคิดเดียวกับ `projectDataFor` ที่บอกบอทว่า "ไม่รู้จริง ๆ ถ้าไม่มีข้อมูล")

## 9. Recommended integration points (สรุปเป็นคำตัดสิน)

| ประเด็น | คำตัดสิน | เหตุผล |
|---|---|---|
| ที่อยู่ service | `services/answer-hub/*.mjs` + RPC `inbox.ah_*` | ตาม convention QR/stats/logs — server.mjs เพิ่ม whitelist AH_ACTIONS เท่านั้น |
| API รูปแบบ | ประตูเดิม `POST /api/command {action, data}` | ได้ session/CSRF/log ฟรี ไม่เพิ่ม attack surface |
| Schema | `answer_hub` ใหม่ทั้งหมด, RLS + revoke + grant execute ตาม health pattern | กันผิดพลาดเดิม (ทับของเก่า) |
| Migration | ไฟล์ใหม่ `YYYYMMDDHHMM_*.sql` ต่อท้าย ORDER.txt, idempotent, ห้ามแตะไฟล์เก่า | กฎของ repo + incident 032 |
| Bot ใช้คำตอบ | ผ่าน `connect_worker` RPC ที่เพิ่ม action ใหม่ (`ah_bot_answers`) เท่านั้น — ห้าม SQL ตรง | ADR-002 |
| Learning hook | ที่ `human_reply` action + inbound receive path, fire-and-forget, flag ปิดได้ | ADR-003 + กฎ "worker failure ห้ามพัง inbound" |
| Role | sales/senior_sales = ใช้+เสนอ, manager = รีวิว, admin = approve/จัดการหมวด/source/import | ใช้ role จริง ไม่สร้างใหม่ |

## 10. Flow mapping เดิม → ใหม่ (ย่อ)

- `bootstrap` (มี quick_replies ฝังมา) → จะฝัง `answer_suggestions` เมื่อเปิด Conversation (Phase 13) ผ่าน action ใหม่ ไม่แตะโครง bootstrap เดิมจนกว่า flag เปิด
- composer `/` templates → Quick Answer panel ใหม่ทำงาน "เติมข้อความ" เหมือนเดิม (send path เดิมไม่แตะ) → usage log เรียกหลัง send สำเร็จ
- `bots/reply.mjs` → เพิ่ม `services/answer-hub/bot-bridge.mjs` คั่นกลาง (hub ก่อน, Claude fallback) โดย default ปิด flag จนผ่าน test

---
*ตรวจโดย: Claude Code, Phase 0 ของ Answer Knowledge Hub · แหล่งอ้างอิง: โค้ดจริง + live DB catalog (supabase-db container) + docs/handoff เดิม*
