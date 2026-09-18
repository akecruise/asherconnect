# ARCHITECTURE — Answer Knowledge Hub

อ้างอิงของเดิม: `AUDIT.md` · การตัดสินใจ: `adr/`

## ชั้นทั้งหมด (และที่อยู่จริง)

```
┌─ Browser ──────────────────────────────────────────────────────┐
│  index.html (คนขาย)          answer-hub.html (admin)           │
│  public/app.js + quick-answer.js   public/answer-hub.js        │
│  vanilla JS · CSP 'self' · DOM API only · ไทย                  │
└──────────────┬─────────────────────────────────────────────────┘
               │ POST /api/command {action, data}   (ประตูเดียว — session cookie + checkOrigin)
┌──────────────▼─────────────────────────────────────────────────┐
│  server.mjs                                                     │
│   • AH_ACTIONS whitelist (Set) — กันเรียกนอกทะเบียน             │
│   • services/answer-hub/*.mjs — logic ฝั่ง Node (resolve,       │
│     render template, import parse, recommend scoring)           │
│   • rpcDirect(token, 'ah_*', …) → PostgREST                     │
└──────────────┬─────────────────────────────────────────────────┘
               │ /rest/v1/rpc/<fn>  (profile inbox, Bearer = ตัวตนจริงของคน / service_role ของ worker)
┌──────────────▼─────────────────────────────────────────────────┐
│  PostgreSQL (self-hosted Supabase)                              │
│   inbox.ah_*    — ฟังก์ชันระดับ API (security definer,          │
│                   set search_path='', ตรวจ role ในฟังก์ชันเอง)   │
│   answer_hub.*  — ตาราง + ฟังก์ชันภายใน (RLS on, ไม่มี policy   │
│                   = deny direct access ทุก role)                │
│   core/inventory/public(promotions, project_facts)/crm          │
│                   — ERP ของจริง อ่านผ่าน resolver เท่านั้น       │
└────────────────────────────────────────────────────────────────┘
               ▲
  bots path: worker job 'generate' → services/answer-hub/bot-bridge.mjs
             → rpcDirect(service, 'ah_bot_recommend', …) — ห้าม SQL ตรง (ADR-002)
```

## กติกา 3 ข้อที่ยืมจาก server.mjs เดิม (ยึดเดิมไม่เปลี่ยน)

1. catch ไหนก็ต้องบันทึก error — ห้ามกลืนเงียบ
2. browser เห็นเฉพาะ code ใน safeCodes; รายละเอียดจริงอยู่ใน log ฝั่ง server
3. ความล้มเหลวของ Answer Hub **ห้ามพัง messaging**: Quick Answer โหลดไม่ได้ →
   composer ยังพิมพ์ได้; resolve พัง → ตอบ fallback_text / ส่งมนุษย์; learning hook พัง →
   inbound เดินต่อ (ทุก hook เป็น fire-and-forget + flag)

## Components และความรับผิดชอบ

| Module (ใหม่) | หน้าที่ | ไม่ทำ |
|---|---|---|
| `services/answer-hub/service.mjs` | getAnswer/listAnswers/searchAnswers/resolveAnswer/recommend/create/update/approve/retire/recordUsage/feedback/learning/import — เรียก RPC `inbox.ah_*` | ไม่ query ตารางตรง ๆ ผ่าน PostgREST REST table API |
| `services/answer-hub/render.mjs` | render `{{variable}}` จาก binding + context; ค่า required ขาด → คืน missing list ไม่เดา | ไม่แตะ DB |
| `services/answer-hub/sources.mjs` | resolve logical source → SQL function ของ ERP จริง + cache TTL ต่อ source | ไม่มี SQL string จาก user |
| `services/answer-hub/import.mjs` | parse xlsx/csv → rows → validate → preview/commit | ไม่ write ถ้า admin ไม่ยืนยัน |
| `services/answer-hub/bot-bridge.mjs` | จุดตัดสินใจของบอท: hub ก่อน → Claude fallback; บังคับ audience/bot_auto_answer/valid/resolve ทั้งหมด | ไม่ส่งเอง — คืนข้อความให้ flow เดิม (`bot_reply`) เป็นผู้ส่ง |
| `services/answer-hub/learn.mjs` | สร้าง learning candidate จาก (customer_question, human_reply) + similarity/quality | auto-approve ไม่ได้แม้แต่บรรทัดเดียว |

## Data flow หลัก 2 เส้น

### A. Quick Answer (คนขาย)
```
พิมพ์คำถาม → action ah_recommend {text, conversation_id, project}
  → recommendAnswers(): keyword+trgm+intent+category+project+priority+usage
  → คืน [{answer_id, title, body(resolved), score, reason, missing[]}]
→ คนขาย Preview / Edit / Send (send ใช้ path เดิมทั้งหมด)
→ หลัง send สำเร็จ → ah_use {answer_id, was_edited, final_text} → answer_usage
→ Report incorrect → ah_feedback
```

### B. Bot
```
job 'generate' (เดิม) → bot-bridge:
  1) ah_bot_recommend (RPC, ผ่าน whitelist ฝั่ง worker)
  2) ตัวเลือกที่ผ่านตัวกรองทั้งหมด (approved + audience bot/both + bot_auto_answer
     + valid_from/to + binding resolve สำเร็จ + source bot_allowed)
  → ใช้ข้อความนั้น → flow เดิม bot_reply
  3) ไม่ผ่าน/ไม่มี → Claude generation เดิม (project-data .md) ไม่เปลี่ยน
```

## Source Registry flow (Phase 4 — ทำงานแล้ว)

```
Answer → answer_data_binding (Phase 5 — ✅ ผ่าน inbox.ah_resolve · render ผ่าน
         services/answer-hub/render.mjs)
       → source_registry (source_code → object_name เท่านั้น — ห้าม interpolate SQL จากแถว)
       → src_check_allowed (active + bot_allowed/human_allowed — deny by default ฝั่งบอท)
       → answer_hub.src_* (เฉพาะฟังก์ชันที่อนุมัติ — security definer, search_path='')
       → ERP จริง (core.project / inventory.unit / public.promotions / public.project_facts / crm)
       → normalized jsonb: {"status":"ok","value":…} หรือ {"status":"missing","reason":…}
```
- ค่าที่ไม่มีจริง = missing + เหตุผล (ห้ามเดา) — ฝั่ง render ใช้ fallback_text (Phase 5)
- **media-ready ตามหลัก**: ค่าคืนเป็น jsonb ไม่ผูก scalar/text — อนาคตแหล่งรูป/ไฟล์
  (PROJECT_MEDIA / UNIT_MEDIA / FLOOR_PLAN / PROMOTION_MEDIA) ใส่ media id / storage path /
  mime type / metadata ใน `value` เดิมได้ ไม่ต้องแก้โครงสร้างทะเบียน

## Answer Service Layer (Phase 6 — ทำงานแล้ว)

```
UI / Bot / Quick Answer / (Learning · Recommend · Analytics — Phase ถัด ๆ ไป)
  → services/answer-hub/service.mjs   ← จุดกลางเดียว ห้าม consumer query ตารางตรง
      flags (5 ตัว default ปิด) · uuid/validity/bot policy · error model ANSWER_*
  → RPC inbox.ah_* (ด่านสิทธิ์จริงใน SQL — service ไม่มีอำนาจตัดสินแทน)
  → Answer Hub DB (answer_item/binding/registry)
  → Data Binding → src_resolve → Source Registry → ERP
  → render.mjs → rendered_text (+ warnings/requires_human_review)
```

- ทางเข้าเดียวจาก server.mjs: `answerHub.handle(action, token, data)` — action ใน AH_ACTIONS
  ทั้งหมด · `ANSWER_HUB_ENABLED` ปิด = ทุก action คืน `{ok:false, code:'HUB_DISABLED'}`
- ของที่ยังไม่ถึง (recommend Phase 14 / usage Phase 16 / feedback Phase 17) คืน
  `NOT_AVAILABLE_YET` พร้อม phase — ห้าม fake result
- resolve ต่อยอด Phase 5 เท่านั้น (ah_resolve + render.mjs) — static ไม่โดน dynamic flag,
  dynamic โดน `ANSWER_HUB_DYNAMIC_DATA_ENABLED`

## Versioning & Approval

- แก้ answer ที่ `status='approved'` → บังคับเข้า `answer_version` (snapshot ก่อนแก้)
  + สถานะกลับไป `review` (ถ้า flag บังคับ) หรือ approve ใหม่โดย admin — กำหนดตายใน RPC
- สถานะ: draft → review → approved → retired (retire ยังอยู่ในประวัติ, ห้ามลบแถว)

## Data Priority (คำตอบ render จากอะไรก่อน)

1. ERP Live Data (resolver ต่อ context) → 2. Admin Approved Manual → 3. Approved
Learned → 4. Imported Approved → 5. AI Draft (บอทเท่านั้น และห้าม override ข้อ 1–4)

## Feature flags (Phase 29, ใช้ตั้งแต่ Phase 6 มี default ปิด)

`ANSWER_HUB_ENABLED, ANSWER_HUB_LEARNING_ENABLED, ANSWER_HUB_BOT_ENABLED,
ANSWER_HUB_IMPORT_ENABLED, ANSWER_HUB_DYNAMIC_DATA_ENABLED`
อ่านจาก env ตอน boot + override ด้วย `inbox.settings` key `answer_hub.*`
(ตรวจทุกครั้งที่เรียก — ปิดได้ทันทีไม่ต้อง deploy, ตามปรัชญา send.live_enabled เดิม)

## สิ่งที่ตั้งใจ **ไม่** ทำ

- ไม่แตะ `connect_private.api`/`worker` dispatcher (ผ่อน incident เดิม)
- ไม่แตะ migration/migrations ของ asher-web (Quick Reply)
- ไม่สร้าง Quick Reply ซ้ำ — hub อยู่ "ข้างบน" QR เดิม
- ไม่ให้ LLM เขียนลงฐานตรง ๆ (AI แค่ draft ให้คน approve)
- ไม่ใช้ pgvector/embeddings ใน Phase แรก (recommend = SQL ล้วน ตาม Phase 14 spec)
