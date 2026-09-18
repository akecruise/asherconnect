# ADR-005 — เชื่อม Quick Reply ด้วย link table ไม่ ALTER ตารางเดิม

Status: ACCEPTED (2026-09-17)

## บริบท
Master Command ให้เชื่อม `inbox.quick_reply` กับ `answer_hub.answer_item` เช่นเพิ่ม
column `answer_item_id` — แต่ตาราง QR ทั้งชุด migration อยู่ใน **repo asher-web**
(`supabase/migrations/20260916154809_quick_reply.sql`) ใช้ ledger คนละชุดกับ
asher-connect (`inbox.sql_applied`); การ ALTER ข้าม repo ทำให้เจ้าของ schema กำกวม
และเสี่ยงชนกับ migration ถัดไปของ asher-web

## การตัดสินใจ
สร้าง `answer_hub.quick_reply_link`:
`quick_reply_id PK/FK → inbox.quick_reply` · `answer_item_id` · `sync_mode(manual|mirror)` ·
`category_code` · timestamps

## เหตุผล
- ความเป็นเจ้าของชัด: ตาราง QR ไม่ถูกแตะจาก repo นี้เลย
- legacy QR (ไม่มี link) ใช้เดิมได้ 100% — ตรงเป้า "ห้ามลบ QR เดิม / ไม่สร้างซ้ำ"
- ถอนการเชื่อม = ลบแถว link ปลอดภัยกว่า drop column

## ผลที่ตามมา
- การ join รายการ Quick Answer = left join link; ของเก่าที่ไม่ผูกยังโชว์ปกติ
- ห้าม RLS/grant แตะตาราง QR เดิมใด ๆ
