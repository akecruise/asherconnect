# ADMIN GUIDE — คลังคำตอบ (โครง — เนื้อหาเต็มตาม Phase 8–12, 25)

> กำหนดหน้าที่ตาม role จริงของระบบ: admin = ทุกอย่าง, manager = รีวิว/เห็นรายงาน,
> senior_sales = รีวิวเฉพาะของทีม, sales = ใช้/เสนอ/รายงานเท่านั้น

## จะเข้าหน้าคลังคำตอบ
เมนู Admin → คลังคำตอบ (URL `/answer-hub`) — จะเพิ่มหลัง Phase 8

## เพิ่มคำตอบ (Phase 9)
1. คลังคำตอบ → เพิ่มคำตอบ
2. กรอก: ชื่อคำตอบ, หมวด, Intent, โครงการ (หรือทุกโครงการ), คำถามตัวอย่าง, Template
3. เลือกชนิด: Static (ข้อความนิ่ง) / Dynamic (มี `{{ตัวแปร}}`) / Hybrid
4. เลือกผู้ใช้ได้: Human / Bot / Both — ★ บอทใช้ไม่ได้จนกว่า admin จะเปิด "อนุญาตให้บอทตอบเอง"
5. Preview (resolve ข้อมูลจริงจาก ERP) → บันทึก Draft → ส่งตรวจ → Approve

## แก้คำตอบ (Phase 3, 9)
- แก้คำตอบที่ approved → ระบบเก็บ version เดิมให้อัตโนมัติ + สถานะกลับเข้าตรวจ
- ดูประวัติ: Versions tab — v1, v2, v3 พร้อมผู้แก้/เหตุผล

## Approve / Retire
- Approve เฉพาะ admin · Retire ยังเก็บประวัติ หาจากตัวกรอง "Retired" ได้

## Import (Phase 10) → IMPORT-GUIDE.md
## Learning Queue (Phase 12) → LEARNING-GUIDE.md
## จัดการหมวดหมู่ / Intent (Phase 8)
- หมวดเริ่มต้น 10 หมวดมีให้ — สร้างย่อย/แก้ชื่อได้ ห้ามลบ (มีคำตอบผูกอยู่ = retire แทน)
## จัดการ ERP Sources (Phase 8)
- เปิด/ปิด source, ตั้ง freshness, อนุญาตบอท — แก้ไม่ได้ว่า source ชี้ object ไหน (ของ dev)
## ดู Usage / Feedback (Phase 16–17)
- Most used / most edited / most reported / คำตอบที่ควรทบทวน
## ดู Health (Phase 20)
- /admin/health มีส่วนของ Answer Hub: pending learning, failed sources, last resolve error
