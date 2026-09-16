# Media pipeline verification

วันที่ 2026-09-16 — ตรวจใน local workspace ก่อน deploy

- `node --check` ผ่านสำหรับ `server.mjs`, `providers.mjs`, `lib/media.mjs` และ `lib/media-http.mjs`
- media/auth regression ผ่าน 17/17 ข้อ รวมการทดสอบ HTTP จริงของ proxy: anonymous 401, unauthorized 403, authorized stream 200, และ `detail`/`messages` เติม media
- regression เดิมของบอทและรายงานผ่านเมื่อใช้ `supabase-db` local; ชุดเต็มหยุดที่ `tests/http.integration.mjs` ด้วย `fetch failed` จากบริการ upstream ที่ไม่ได้เปิดใช้งาน
- migration 037 และ selftest ผ่านใน transaction ที่ `ROLLBACK` ทันทีบน `supabase-db`; ไม่มีข้อมูลถาวรถูกเขียน
- `asher-web`: `tsc --noEmit --incremental false` ผ่าน และ `npm run lint` ผ่านโดยมี warning เดิมเรื่อง `<img>` กับ `tunnel-up.mjs` ไม่มี error

ยังไม่ได้ทำกับ production: apply migration, สร้าง bucket, restart/deploy container, backfill หรือส่งไฟล์จริงจาก LINE/Messenger ต้องทำตามลำดับใน `.handoff/media-pipeline-handoff.md` และตรวจคำสั่งที่เปลี่ยนสถานะกับ Ake ก่อนรัน
