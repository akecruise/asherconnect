# TROUBLESHOOTING — Answer Knowledge Hub (โครง — เต็มตาม Phase 28)

| อาการ | ตรวจอะไรก่อน | วิธีแก้ทั่วไป |
|---|---|---|
| Quick Answer ไม่ขึ้น | flag เปิด? bootstrap มี quick_replies? console error? | ปิด/เปิด ANSWER_HUB_ENABLED; hub พัง → QR เดิมยังใช้ได้ |
| Answer search ไม่เจอ | status=approved? project ตรง? หมวดถูก? | ตรวจ filter ในหน้าคลัง; คำค้นสั้นไป |
| Bot ไม่ใช้คำตอบ | bot_auto_answer? audience? valid วันที่? source bot_allowed? | เปิดตามลำดับใน BOT-GUIDE; ดู log `bot_answer_selected` |
| Dynamic data ว่าง | source active? ข้อมูล ERP มีจริง? cache TTL? | เติม fallback_text; ตรวจ src_* ด้วย SQL ตรง |
| ERP source error | log `source_resolve_failed` | ตรวจ object_name; ปิด source ชั่วคราว |
| Learning ไม่สร้าง | ANSWER_HUB_LEARNING_ENABLED? hook log? | ดู log `learning_candidate_created`; inbound ปกติหรือไม่ |
| Import fail | แถว invalid สีแดงใน preview? encoding UTF-8? | แก้ไฟล์ตาม IMPORT-GUIDE; commit ต้องเป็น batch เดียว |
| Duplicate answer | title+project ซ้ำ? | merge หรือ retire ตัวเก่า |
| Permission denied | role จริงใน core.profile? | approve/retire เฉพาะ admin, รีวิวเฉพาะ manager+ |
| Migration fail | sha mismatch ใน ledger? ORDER.txt ครบ? | ห้ามแก้ไฟล์ที่ apply แล้ว — สร้างไฟล์ fix ใหม่เสมอ |
| Health degraded | /admin/health ช่องไหนแดง | ดู flow_event ตาม stage; failed sources ใน snapshot |

## Source Registry (Phase 4 — อาการที่เจอได้จริง)

| อาการ | เหตุผลจริง | ทางแก้ |
|---|---|---|
| src_* คืน `{"status":"missing"}` | ตามดีซายน์ — ค่าไม่มีจริง (โครงการไม่มียูนิต / project_facts ว่าง / โปรหมดอายุ) ไม่ใช่ระบบพัง | เติม fallback_text ใน binding (Phase 5) หรือเติมข้อมูลฝั่ง ERP |
| reason `source_inactive` | แหล่งถูกปิด (seed ปิดไว้: APPOINTMENT_SLOT, LEAD_PROFILE, LEAD_FOLLOWUP) | มีข้อมูลจริงพอแล้วค่อยเปิด — admin ยิง `ah_source_save {active:true}` ไม่ต้อง deploy |
| reason `bot_not_allowed` / `human_not_allowed` | deny by default — บอทถูกปิดทุกแหล่งตอน seed | เปิด `bot_allowed` ทีละแหล่งผ่านประตูตอน Phase 15 |
| reason `project_not_found` / `fact_not_found` | project id ไม่มีจริง / fact_key ไม่มีแถว หรือ is_public=0 | ตรวจ id กับ core.project; ค่าภายใน (is_public=0) ออกไม่ได้ตามออกแบบ |
| reason `invalid_status` | p_status ไม่ใช่ label ของ enum `unit_status` | ใช้เฉพาะ available / hold / booked / contracted / transferred |
| ราคา/จำนวนยูนิตไม่ตรง ERP | cache freshness (default 300s) หรือคนละนิยาม — "พร้อมขาย" นับ available เท่านั้น ไม่รวม hold/booked | รอ TTL หรือปรับ freshness_seconds ผ่าน `ah_source_save`; ดูนิยามใน DATABASE.md |

## Answer Service (Phase 6)

| อาการ | เหตุผลจริง | ทางแก้ |
|---|---|---|
| ทุก action `ah_*` คืน `HUB_DISABLED` | flag หลักยังปิด (default ปิดหมดตั้งแต่ Phase 6) | ตั้ง `ANSWER_HUB_ENABLED=1` ทาง env (หรือ override ทาง inbox.settings เมื่อมี) |
| resolve คืน `FEATURE_DISABLED` | `ANSWER_HUB_DYNAMIC_DATA_ENABLED` ปิด — ของ dynamic ถูกกั้น (static ไม่โดน) | เปิด flag ถ้าต้องการข้อมูล dynamic จาก ERP |
| code คืนเป็น `ANSWER_EXPIRED` | คำตอบหลุดช่วง valid_from..valid_to (service ตรวจก่อนส่ง) | แก้วันที่ของ answer ผ่าน ah_save |
| code `ANSWER_NOT_ALLOWED` | สิทธิ์ไม่พอ (sales แตะของ draft/approve) หรือ bot policy (audience/bot_auto_answer) | ดู log `answer_permission_denied` บอกเหตุผลย่อย |
| `RENDER_FAILED` | render.mjs throw (แทบไม่เกิด — ออกแบบไม่ throw) | ดู log `answer_service_resolve_failed`; รายงาน template ที่มีปัญหา |
| code `INTERNAL_ERROR` | RPC ล้มด้วยเหตุที่ไม่อยู่ใน map — ข้อความดิบถูก log ไว้แล้ว | หา log `answer_service_rpc_failed` ดู raw_code |

## กฎการไล่ปัญหา (จาก header ของ server.mjs เดิม)
1. หาว่า "ชั้นไหน" พังก่อน: browser → /api/command → RPC → SQL → ERP source
2. ดู log JSON ตาม event name (Phase 21) — error เต็ม ๆ อยู่ฝั่ง server เสมอ หน้าจอเห็นแค่ code
3. พังชั้นไหนจริง ๆ แล้วค่อยแก้ — ห้ามแก้ข้ามชั้นลุย ๆ
