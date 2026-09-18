# ROLLBACK — Answer Knowledge Hub (โครง — เต็มตาม Phase 27)

## หลัก: ปิดสวิตช์ก่อนเสมอ แล้วค่อยย้อนโค้ด — DB ของ hub ออกแบบให้ปล่อยทิ้งได้ปลอดภัย

## 1. Feature disable (เร็วสุด ไม่ต้อง deploy)
ตั้งใน `inbox.settings` (key `answer_hub.*`) หรือ env แล้ว `docker compose up -d`:
| ปิดอะไร | flag | ผลทันที |
|---|---|---|
| ทั้งระบบ | ANSWER_HUB_ENABLED=false | UI/panel หาย, QR เดิมใช้เต็มรูปแบบ |
| เรียนรู้ | ANSWER_HUB_LEARNING_ENABLED=false | หยุดเก็บ candidate |
| บอท | ANSWER_HUB_BOT_ENABLED=false | บอทกลับ fallback Claude เดิม |
| import | ANSWER_HUB_IMPORT_ENABLED=false | ปิดหน้า import |
| dynamic data | ANSWER_HUB_DYNAMIC_DATA_ENABLED=false | คำตอบ dynamic ตอบด้วย fallback text |

## 2. Code rollback
สลับ dir บน VPS กลับเป็น image/commit ก่อนหน้า (`docs/deploy.md` วิธีเดิม) — ไม่ต้องแตะ DB

## 3. Quick Answer fallback
composer ตรวจ bootstrap: hub ปิด/พัง → ซ่อน panel, QR เดิม (`quick-replies.js`) ทำงานเหมือนเดิมทุกอย่าง

## 4. Bot disable
ปิด flag ข้างบน **หรือ** สวิตช์เดิม bot_switch/send_switch ของระบบเดิมยังมีอำนาจเหนือกว่าเสมอ

## 5. Database rollback
- migration ของ hub = สร้าง schema/ตาราง/ฟังก์ชันใหม่ล้วน → **ไม่ต้องย้อน** (ปล่อยไว้ไม่กระทบของเดิม)
- ถ้าจำเป็นจริง: drop ตามลำดับย้อนกลับ (learning/usage/feedback tables → answer_hub ทั้ง schema)
  — ทำเฉพาะเมื่อ มี backup + ปิด flag ทุกตัวแล้ว + ผู้ดูแลอนุมัติ
- ห้ามแก้/ลบ migration ไฟล์เก่าของระบบเดิมเด็ดขาด

## Emergency procedure
ลูกค้าได้คำตอบผิดจากบอท: ปิด ANSWER_HUB_BOT_ENABLED (30 วินาที) → ปิด bot_switch เดิม →
แจ้งทีม → เก็บ evidence จาก flow_event + usage → แก้คำตอบ/retire
