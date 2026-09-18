# Handoff — Quick Replies Admin / Production

วันที่ 17 กันยายน 2026 · ผู้รับงาน: session ถัดไป

## สถานะล่าสุด

งาน UI Quick Replies ฝั่ง Inbox และหน้า Admin ถูก deploy ไปยัง production แล้วที่:

- VPS source: `/opt/asher-inbox/app`
- service/container: `asher-connect` / image `app-asher-connect`
- backup ล่าสุด: `/opt/asher-inbox/app.bak-quick-ui-20260916165716`
- `/health`: HTTP 200
- `/quick-replies.js`: HTTP 200
- `/quick-replies`: หน้า Admin ตอบ HTTP 200

หน้า Inbox มี `#quick-replies`, `#template-menu`, `#message` ครบ และปุ่มถูกบังคับให้แสดงบน desktop เพราะ CSS เดิมซ่อน `.composer-attach` ทุกตัวที่จอกว้างกว่า 768px

## ไฟล์ที่แก้/เพิ่ม

- `server.mjs` — static routes และ server-side actions `quick_replies_list`, `quick_reply_upsert`, `quick_reply_toggle`; Save/Disable ตรวจ role `admin`
- `public/index.html` — ปุ่ม Quick Replies และ script tag
- `public/app.js` — bridge `window.asherQuickReplies` จาก bootstrap
- `public/quick-replies.js` — picker, search, category, sort, mobile layout, fallback canned responses
- `public/quick-replies-admin.html` — หน้า list/form
- `public/quick-replies-admin.js` — list/search/edit/disable/save/character counter
- `public/app.css` — style picker ใน working tree (ตัว picker production มี inline fallback ใน `quick-replies.js`)
- `scripts/install-quick-ui.mjs`
- `scripts/deploy-ui-vps.sh`

## ฐานข้อมูล

ใช้ migration/RPC ที่มีอยู่แล้วจาก Quick Reply migration:

- `inbox.quick_reply`
- `inbox.quick_reply_attachment`
- `inbox.quick_reply_usage`
- `inbox.qr_list`
- `inbox.qr_upsert`
- `inbox.qr_toggle`
- `inbox.qr_send`

ไม่เปิด service role key ให้ browser

## ค้างอยู่ ต้องทำต่อ

1. หน้า Admin ยังไม่มี file upload เข้า Supabase Storage และยังไม่ได้ผูก `attachment_ids` ในฟอร์ม
2. `qr_list` RPC เดิมกรอง `q.active` เสมอ จึงไม่แสดง Inactive ในรายการ Admin หลังปิดใช้งาน ต้องแก้ RPC/migration ให้ admin เห็นทั้ง active/inactive โดยยังซ่อน inactive จาก sales
3. ต้องทดสอบผ่าน browser session จริงด้วยบัญชี admin: login → `/quick-replies` → Add/Edit/Disable → กลับ Inbox แล้วกด ⌘ ตรวจข้อมูลใหม่
4. ควรเพิ่ม automated test สำหรับ endpoint ทั้งสาม action และทดสอบ role non-admin ได้ 403
5. ก่อน deploy ครั้งถัดไปใช้สคริปต์ทุกครั้ง ห้าม upload archive ที่มี `.env`, secrets, channels หรือ node_modules

## คำสั่งตรวจที่ใช้

```bash
curl -ks -w '%{http_code}\n' https://inbox.apluscondo.com/health
curl -ks -w '%{http_code}\n' https://inbox.apluscondo.com/quick-replies.js
docker ps --filter name=asher-connect
```

`npm.cmd run check` ผ่านก่อน deploy

