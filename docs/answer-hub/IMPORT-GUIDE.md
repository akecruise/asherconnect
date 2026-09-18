# IMPORT GUIDE — นำเข้าคำตอบจาก Excel/CSV (โครง — เนื้อหาเต็มตาม Phase 10, 25)

## ไฟล์ที่รองรับ
`.xlsx` และ `.csv` (UTF-8)

## Template columns

| column | บังคับ | ค่าที่ยอม |
|---|---|---|
| category | ✓ | code ของหมวด (เช่น price_promo) หรือชื่อไทยตรง seed |
| intent | | code เช่น ask_price |
| title | ✓ | ชื่อคำตอบ (ไม่ซ้ำในโครงการเดียวกัน) |
| question | | คำถามตัวอย่าง (1 บรรทัด) |
| answer | ✓ | เนื้อคำตอบ รองรับ {{ตัวแปร}} |
| project | | ว่าง=ทุกโครงการ / asher-naii / asher-vibe |
| answer_type | | static (default) / dynamic / hybrid |
| audience | | both (default) / human / bot |
| show_in_quick_answer | | true (default) / false |
| bot_auto_answer | | false (default) / true |
| priority | | ตัวเลข (default 100) |
| valid_from / valid_to | | วันที่ YYYY-MM-DD |

## Flow
Upload → Parse → Validate → Preview (นับ New/Update/Duplicate/Invalid/Skipped/Failed
+ ตัวอย่าง 10 แถวแรก) → **Admin กดยืนยัน** → Import เป็น transaction เดียว → สรุปผล

## กติกา Duplicate
แถวที่ title+project ซ้ำกับของเดิม = Update (สร้าง version อัตโนมัติ) หรือ Skipped — เลือกได้ในหน้า Preview

## Validation ที่ทำทุกแถว
ความยาว, enum ตรง, category/intent/project มีจริง, template ตัวแปรถูกชื่อ, CSV injection
(`=`, `+`, `-`, `@` นำหน้า) ถูก sanitize

## Rollback
Import ทั้ง batch เขียนครั้งเดียวใน transaction — พังกลางทาง = ไม่เหลือเศษ;
ย้อนหลังหลัง commit ใช้ retire ทีละชุด (source_type=import) หรือ restore จาก version
