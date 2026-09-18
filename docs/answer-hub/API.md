# API — Answer Knowledge Hub

ประตูเดียวเหมือนแอปเดิม: `POST /api/command` พร้อม session cookie (`/api/login`)
Body: `{ "action": "<action>", "data": { … } }` · Response: JSON ของ RPC หรือ error code ภาษากลาง (safeCodes)

ทุก action ใหม่ของ hub ขึ้นต้นด้วย `ah_` และถูก whitelist ใน `AH_ACTIONS` (server.mjs)
ก่อนเดินผ่าน **Answer Service** (`services/answer-hub/service.mjs` — Phase 6) ไปยิง
`inbox.<action>()` — **สิทธิ์จริงตรวจใน SQL เสมอ**

**ตั้งแต่ Phase 6:** action ทั้งหมดผ่าน flags (default ปิด) — `ANSWER_HUB_ENABLED` ไม่เปิด =
ทุก action คืน `{ok:false, code:'HUB_DISABLED'}` (HTTP 200 — เช็คที่ field `ok`/`code`) ·
error ทั้งหมดถูก map เป็น error model กลาง `ANSWER_*` (ANSWER_NOT_FOUND/ANSWER_NOT_ALLOWED/
ANSWER_EXPIRED/SOURCE_DISABLED/SOURCE_NOT_ALLOWED/DATA_NOT_FOUND/RENDER_FAILED ฯลฯ) —
client ไม่มีทางเห็น raw SQL error · ของที่ยังไม่ถึงคืน `NOT_AVAILABLE_YET` พร้อม phase

## Actions (Client → Hub)

| action | data | ใครใช้ได้ | คืน |
|---|---|---|---|
| `ah_recommend` | `{text, conversation_id?, project?, limit?}` | sales ขึ้นไป | `[{answer_id, title, body, score, reason, missing[], bindings}]` (body resolve แล้วตาม context) |
| `ah_list` | `{status?, category_id?, intent_id?, project?, query?, page?}` | sales ขึ้นไป (แต่ draft/review เห็นเฉพาะ manager+) | `{rows[], total}` |
| `ah_get` | `{id}` | sales ขึ้นไป | `{item, versions[], bindings[]}` (อัปเกรด Phase 5 — ไม่มี patterns จน Phase ของ question_pattern) |
| `ah_resolve` | `{answer_id, context{project_id?, lead_id?}}` | sales ขึ้นไป (approved เท่านั้น — draft/review เฉพาะ manager+) | `{values{var:ค่า}, missing[], ok, detail[]}` — ✅ Phase 5 |
| `ah_binding_list` | `{answer_item_id}` | manager+ | `{rows[], total}` — ✅ Phase 5 |
| `ah_binding_save` | `{answer_item_id, variable_name, source_code? หรือ source_id?, source_field?, required?, fallback_text?, cache_ttl_seconds?}` | manager+ | แถวผูกหลังบันทึก (upsert ตาม (item, variable)) — ✅ Phase 5 |
| `ah_binding_delete` | `{id}` | manager+ | แถวที่ถูกลบ — ✅ Phase 5 |
| `ah_save` | `{id?, …fields, change_reason?}` | manager/admin | `{id, status, version_no?}` — แก้ของ approved → สร้าง version อัตโนมัติ |
| `ah_approve` | `{id}` | admin | `{id, status:'approved', approved_at}` |
| `ah_retire` | `{id, reason}` | admin | `{id, status:'retired'}` |
| `ah_category_save` | `{id?, code, name_th, name_en?, parent_id?, sort_order?, active?}` | admin | `{id}` |
| `ah_intent_save` | `{id?, code, name, category_id?, active?}` | admin | `{id}` |
| `ah_pattern_save` | `{intent_id, question_text, id?}` | admin | `{id}` |
| `ah_source_list` | `{active?}` (กรองได้) | manager+ | `{rows[], total}` ครบทุกคอลัมน์ทะเบียน (ไม่มี secret) — ✅ Phase 4 |
| `ah_source_save` | `{id? หรือ source_code?, bot_allowed?, human_allowed?, freshness_seconds? (≥0), active?, description?}` | admin | แถวทะเบียนหลังแก้ — แก้เฉพาะแหล่งที่มีอยู่ (เพิ่ม/ลด = migration เท่านั้น) — ✅ Phase 4 |
| `ah_import_preview` | `{rows[]}` (parse ฝั่ง Node แล้ว) | admin | `{new, update, duplicate, invalid[], skipped, sample[]}` |
| `ah_import_commit` | `{batch_token}` | admin | `{counts, errors[]}` |
| `ah_learning_list` | `{status?, project?}` | manager+ | `{rows[]}` |
| `ah_learning_review` | `{id, decision: approve/edit_approve/merge/reject, answer?}` | manager+ (approve สร้าง item ให้ admin ได้จาก queue เดียวกัน) | `{candidate, answer_id?}` |
| `ah_usage_summary` | `{from?, to?}` | manager+ | counters + most used/edited/reported |
| `ah_feedback_save` | `{answer_item_id, feedback_type, note?, conversation_id?}` | sales ขึ้นไป | `{id}` |
| `ah_feedback_list` | `{type?, limit?}` | manager+ | `{rows[]}` |
| `ah_quick_answer` | `{conversation_id}` | sales ขึ้นไป | payload สำหรับ panel: categories, recent, frequent, suggested |
| `ah_health` | `{}` | gate `health_can_view` (manager+) | snapshot ส่วน hub |

## Bot/Worker-only (service_role เท่านั้น — เรียกผ่าน worker RPC path)

| ฟังก์ชัน | ทำอะไร |
|---|---|
| `ah_bot_recommend` | `{text, project_id, conversation_id}` → คำตอบที่ผ่านตัวกรองบอททั้งหมด (approved+audience+auto+valid+binding ok+source bot_allowed) หรือ `{null, requires_human_review:true}` |
| `ah_learning_create` | hook จาก human reply — สร้าง candidate (dedupe + bump occurrence) |

## Error codes (เพิ่มใน safeCodes)

`ah_not_allowed, ah_not_found, ah_invalid_template, ah_missing_required_data,
ah_invalid_import_row, ah_duplicate, ah_version_conflict, ah_state_not_allowed`

## Edge cases ที่ตกลงกันไว้

- `ah_recommend` หา hub พัง/timeout → คืน `[]` + log — composer ยังใช้ได้ปกติ
- body resolve: variable required และ resolve ไม่สำเร็จ → คืน missing list, ข้อความ
  ไม่ถูกส่งออกไปหาลูกค้าโดยอัตโนมัติ (คนขายเห็นและแก้เอง / บอทส่งมนุษย์)
- import ทุกแถว validate ก่อนเขียน — commit เป็น transaction เดียว พังกลาง → rollback ทั้ง batch
