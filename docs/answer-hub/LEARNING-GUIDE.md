# LEARNING GUIDE — ระบบเรียนรู้จากแชตจริง (โครง — เนื้อหาเต็มตาม Phase 11–12, 25)

## หลักการ (Shadow Learning)
เมื่อลูกค้าถามและ **คนขายตอบเอง** ระบบเก็บคู่ (คำถาม → คำตอบ) เป็น "candidate" เงียบ ๆ
ไม่มีอะไรถูกส่งให้ลูกค้าโดยอัตโนมัติ — candidate ทุกตัวต้องผ่านคนตรวจก่อนเสมอ (ADR-003)

## Candidate คืออะไร
แถวใน `answer_hub.learning_candidate`: คำถามลูกค้า, คำตอบมนุษย์, โครงการ, intent/หมวดที่
ระบบเดา, ความคล้าย (จับกลุ่มคำถามซ้ำ → occurrence_count เพิ่ม), คะแนนคุณภาพ

## Learning Queue (หน้า admin)
แสดง: คำถามลูกค้า / คำตอบมนุษย์ / โครงการ / หมวด / Intent / จำนวนครั้งที่เจอ / Similarity / Quality

## ปุ่มตัดสินใจ
| ปุ่ม | ทำอะไร | ใครกดได้ |
|---|---|---|
| Approve | สร้าง answer_item จาก candidate (bot_auto_answer=**false** เสมอ) | manager+ |
| Edit + Approve | แก้ข้อความก่อนสร้าง | manager+ |
| Merge | รวมเข้าคำตอบที่มีอยู่แล้ว (เพิ่ม question_pattern) | manager+ |
| Reject | ปัดทิ้ง (เก็บประวัติว่าถูกปัด) | manager+ |

## หลัง Approve
- คำตอบใหม่โชว์ให้คนขายทันที (Quick Answer) แต่ **บอทยังใช้ไม่ได้**
- อยากให้บอทตอบเอง → admin เข้าไปเปิด "Allow Bot Auto Answer" เองในภายหลัง

## ความเป็นส่วนตัว
candidate มีข้อความลูกค้า — เห็นได้เฉพาะผู้ login ผ่าน gate role; ไม่มีการส่งออกนอกระบบ

## สวิตช์
`ANSWER_HUB_LEARNING_ENABLED=false` → หยุดเก็บ candidate ทันที (ของเดิมที่เก็บไว้ไม่หาย)
