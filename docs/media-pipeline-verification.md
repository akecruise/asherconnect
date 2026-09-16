# Media pipeline verification

วันที่ 2026-09-16 — ตรวจ local และ deploy production

- `node --check` ผ่านสำหรับ `server.mjs`, `providers.mjs`, `lib/media.mjs` และ `lib/media-http.mjs`
- media/auth regression ผ่าน 17/17 ข้อ รวมการทดสอบ HTTP จริงของ proxy: anonymous 401, unauthorized 403, authorized stream 200, และ `detail`/`messages` เติม media
- regression เดิมของบอทและรายงานผ่านเมื่อใช้ `supabase-db` local; ชุดเต็มหยุดที่ `tests/http.integration.mjs` ด้วย `fetch failed` จากบริการ upstream ที่ไม่ได้เปิดใช้งาน
- migration 037 และ selftest ผ่านใน transaction ที่ `ROLLBACK` ทันทีบน `supabase-db`; ไม่มีข้อมูลถาวรถูกเขียน
- `asher-web`: `tsc --noEmit --incremental false` ผ่าน และ `npm run lint` ผ่านโดยมี warning เดิมเรื่อง `<img>` กับ `tunnel-up.mjs` ไม่มี error
- Production: migration 037 apply สำเร็จบน `supabase-db`; selftest ผ่านและ rollback ข้อมูลทดสอบ
- Production: bucket `inbox-media` มีอยู่แล้วหลัง setup, `public=false`, จำกัด 26,214,400 bytes
- Production: container `asher-connect` rebuild/recreate จาก commit `088c736`, healthy; `/health` คืน `ok:true`
- Production: `GET /media/<path>` โดยไม่มี credentials คืน HTTP 401 ตามนโยบาย private proxy

ยังไม่ได้ทำ: backfill ของเก่า และการส่งไฟล์จริงจาก LINE/Messenger เพื่อ verify end-to-end; ต้องทำตาม checklist ใน `.handoff/media-pipeline-handoff.md`
