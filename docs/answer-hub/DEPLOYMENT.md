# DEPLOYMENT — Answer Knowledge Hub (โครง — เต็มตาม Phase 26)

ยึด `docs/deploy.md` เดิมเป็นหลัก (VPS `root@187.53.139.175`, `/opt/asher-inbox/app`,
deploy จาก git commit เท่านั้น, ห้ามแตะ .env/channels.json/.sessions ฝั่ง VPS)

## Prerequisite
- [ ] ทุก Phase 1–25 เสร็จ + `npm run check` + `npm test` ผ่านบนเครื่อง dev
- [ ] local selftest ของ migration ผ่าน (docker supabase-db)

## ขั้นตอน (เรียงตาย)
1. **Backup DB** ก่อน migration ทุกครั้ง (pg_dump ผ่าน pooler)
2. **Migration** ก่อน code เสมอ: `node sql/run.mjs plan --db "<conn>"` → ตรวจรายชื่อไฟล์
   → `apply --db "<conn>"` (ห้ามข้าม plan)
3. Deploy code: จาก commit (git archive → scp → tar) บน dir ใหม่ → สลับ
4. `docker compose up -d` (เปลี่ยน env ต้อง up -d ไม่ใช่ restart)
5. Smoke test: `curl localhost:3200/health` = 200, login ได้, composer ปกติ, QR เดิมขึ้น
6. Health: /admin/health เขียว + ส่วน Answer Hub ขึ้น

## Environment variables (เพิ่ม — ค่าเริ่มปลอดภัย)
```
ANSWER_HUB_ENABLED=false            # เปิดหลัง smoke test ผ่าน
ANSWER_HUB_LEARNING_ENABLED=false
ANSWER_HUB_BOT_ENABLED=false        # เปิดเป็นส่วนสุดท้าย
ANSWER_HUB_IMPORT_ENABLED=false
ANSWER_HUB_DYNAMIC_DATA_ENABLED=false
```

## Rollback
ดู ROLLBACK.md — สลับ dir กลับ + ปิด flag ได้โดยไม่ต้องย้อน DB (migration ของ hub
สร้างของใหม่ล้วน ไม่แก้ของเดิม จึงปล่อยไว้ได้ปลอดภัย)
