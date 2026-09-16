# Media Pipeline — ท่อเก็บและเสิร์ฟรูป/ไฟล์แนบ (asher-connect)

**วันที่:** 2026-09-16 · **งานต้นทาง:** `.handoff/HANDOFF-asher-connect-images-not-loading.md`

## 1. สาเหตุที่พบจริง (Phase 1 — จากโค้ด + ฐานโปรดักชัน ไม่ใช่การเดา)

อาการตรงตาราง Phase 1 แถว "src ว่าง" → **เกิดพร้อมกันทั้ง 3A และ 3B** และหนักกว่าที่คาด:

| ข้อเท็จจริง | หลักฐาน |
|---|---|
| ข้อความรูปถูกเก็บเป็นข้อความ `[ลูกค้าส่งสื่อแนบ]` อย่างเดียว | `inbox.message` โปรดักชัน: แถว `content_type='attachment'` 6 แถว ไม่มี URL ไม่มีไฟล์ |
| Messenger: URL lookaside **ถูกทิ้งตั้งแต่ขั้นรับเข้า** — ไม่ได้แค่หมดอายุ | `providers.mjs` ยัด attachments ไว้ใน `attribution` แต่ `connect_private.inbound_event` ไม่มีคอลัมน์ payload ให้เก็บ |
| LINE: ไม่มีการเรียก Content API เลย | `server.mjs`/`providers.mjs` ไม่มีสายอักขระ `api-data.line.me` |
| UI ทั้งสองฝั่งไม่มีโค้ดแสดงรูปในแชทเลย | `public/app.js` `renderMessages` เดิมใช้ `textContent` ล้วน · asher-web `ConversationActions` เรนเดอร์ `{message.content}` |
| ไม่ใช่ปัญหา avatar | `<img>` เดียวใน UI คือ avatar (`picture_url`) — ทดสอบจริงได้ HTTP 200 ทั้ง LINE (`sprofile.line-scdn.net`) และ Meta (`platform-lookaside.fbsbx.com`) |
| ★ avatar เป็นระเบิดเวลา ไม่ใช่สาเหตุ | URL lookaside มี `ext=1792058532` = หมดอายุ ~13 ต.ค. 2026 — เก็บเป็น URL ดิบอยู่ จะพังตามเวลา (ดู §5) |
| ยืนยันว่าไม่ใช่ 3C–3F | ยังไม่มี bucket ใด (`storage.buckets` ว่าง) · Caddy ไม่มี route media · log ไม่มี error media (ไม่มีโค้ดให้พัง) |

เหตุผลที่รูปที่ลูกค้าส่ง "ไม่แสดง" ตั้งแต่วันแรกของระบบ: ระบบเก็บแต่ข้อความแทน ไม่เคยดาวน์โหลดไฟล์ — ไม่ใช่ URL หมดอายุอย่างเดียว แต่**สื่อหายทั้งก้อนตั้งแต่ขั้น ingest**

## 2. การออกแบบ (ตาม HANDOFF 3A/3B + ตัวเลือก 3C ข้อ "private + proxy")

```
webhook (LINE/Meta) ──▶ ตอบ 200 ทันที (เดิม)
                          └─▶ คิวขาเข้า (เดิม) ──▶ receive_event ลงฐาน (เดิม)
                                                       └─▶ ★ syncMedia ยิงทิ้ง (ใหม่)
                                                              ดาวน์โหลด (Messenger URL / LINE Content API)
                                                              ▶ bucket private `inbox-media`
                                                              ▶ media_attach() จด path ลง inbox.message.media
หน้าเว็บ ◀── GET /media/<inbox_id>/<message_id>.<ext>  (ใหม่ · ตรวจเซสชันก่อน · stream จาก Storage)
```

- **ไม่ block webhook** — syncMedia ยิงทิ้งเหมือน syncProfiles ทำให้ verify ข้อ "ตอบ Meta < 2 วินาที" ผ่านโดยโครงสร้าง (200 ตอบตั้งแต่ก่อนคิวขาเข้าเดิน)
- **เก็บ path ไม่ใช่ URL เต็ม** — `<inbox_id>/<message_id>[-ลำดับ].<สกุล>` · คน compose URL คือ server
- **private bucket + proxy** — เปิดรูปโดยไม่ login ได้ 401; ตรวจสิทธิ์ active profile และ path ที่ผูกกับข้อความผ่าน `inbox.media_access` ก่อนอ่าน Storage ด้วย service key · ใช้ `private, no-store` เพื่อไม่ให้รูปค้างใน cache หลังออกจากระบบ
- **★ ไม่แตะ `connect_private.api`** — ฟังก์ชันนี้ถูก create or replace ทับกันเองมาแล้ว 4 ไฟล์ (เหตุการณ์ 04:59 ของวันเดียวกัน) แก้ detail ที่ server แทน: หลัง rpc ตอบ ใช้ `media_of()` คืนแผนที่ message_id → media แล้วเติมเข้า `data.messages` · อ่าน fail ก็ข้าม หน้าจอยังเปิดได้
- LINE ใช้ **token ของ channel นั้น** จาก `channels.json` (`naii-line` / `naii-line-oa` คนละ token) — กติกา secret จาก channels.json เท่านั้น; กรณี `contentProvider.type=external` ใช้ `originalContentUrl` โดยไม่แนบ token ของ LINE ตาม [LINE API reference](https://developers.line.biz/en/reference/messaging-api/#image-message)
- Retry 3 ครั้ง (หยุดทันทีที่ 403/404 = ของหมดอายุ) · log มีแต่ message_id กับเหตุผล ไม่มี URL/ของลูกค้า
- เพดาน 25 MB · สติกเกอร์ LINE คงเดิม (เก็บเป็นข้อความ `[สติกเกอร์]` ตามตั้งใจเดิม)

## 3. ไฟล์ที่แก้ทั้งหมด

| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `lib/media.mjs` (ใหม่) | ตัดสิน event ไหนมีสื่อ · คิด path · ด่านตรวจ path (pure module ไม่อ่าน env ตามกติกา lib/) |
| `server.mjs` | `syncMedia` + ตัวดาวน์โหลด/อัปโหลด · เรียกยิงทิ้งจาก `processInbound` · เติม media ในคำตอบ `detail` · เส้นทาง `GET /media/*` |
| `sql/037_media_pipeline.sql` (ใหม่) | คอลัมน์ `inbox.message.media jsonb` · `media_attach()` (เฉพาะ service_role) · `media_of()` (authenticated+service_role) |
| `sql/_selftest/037_media_pipeline_selftest.sql` (ใหม่) | selftest แบบเดียวกับ 033/035 (ไม่เขียนแถวค้าง) |
| `sql/ORDER.txt` | เพิ่ม 037 พร้อมหมายเหตุ "ตั้งใจไม่มี api create or replace" |
| `public/app.js` | `renderMessages`: รูป (`<img /media/...>`) · ไฟล์ (ลิงก์) · ป้ายแทนของเก่าที่กู้ไม่ได้ · caption ที่ลูกค้าพิมพ์ |
| `public/app.css` | สไตล์ `.media-img` / `.media-miss` / `.media-file` / `.media-caption` |
| `asher-web/src/lib/inbox.ts` | select เพิ่ม `content_type, media` |
| `asher-web/src/components/ConversationActions.tsx` | เรนเดอร์รูป/ไฟล์/ป้ายเดิม · ชี้ `/media/` ที่ `inbox.apluscondo.com` (env `NEXT_PUBLIC_CONNECT_URL` ทับได้ ต้อง rebuild) |
| `scripts/ensure-media-bucket.mjs` (ใหม่) | สร้าง bucket private จำกัด 25 MB idempotent |
| `scripts/backfill-messenger-media.mjs` (ใหม่) | สำรวจ/กู้คืนของเก่าผ่าน Graph API · **dry-run เป็นค่าตั้งต้น** เขียนจริงเมื่อใส่ `--apply` |
| `tests/media.test.mjs` (ใหม่) | 9 ข้อ — ตัดสินงาน, path, ext, ด่าน path traversal |
| `package.json` | ต่อ `test:media` เข้า `test` · เพิ่ม `lib/media.mjs` ใน `check` |

## 4. สิ่งที่เพิ่มบน VPS (ทำตอน deploy ตามลำดับ)

1. `sql/run.mjs apply` (ไฟล์เดียว: 037) + selftest 037
2. `node --env-file=.env scripts/ensure-media-bucket.mjs` — สร้าง bucket
3. ส่งไฟล์ตามท่อ tar ปกติ (รวม `lib/` `scripts/` `docs/`) + `docker compose up -d --build asher-connect`
4. Backup: `supabase-storage` ใช้ volume ของตัวเองอยู่แล้ว — ต้องยืนยันว่า volume นั้นอยู่ในชุด backup ของ VPS (ไม่ใช่แค่ pg_dump) ← ตาม verify ข้อสุดท้ายของ HANDOFF

## 5. สิ่งที่ยังต้องทำ / เฝ้าระวัง

- **ของเก่า Messenger** — `scripts/backfill-messenger-media.mjs` (สำรวจก่อนเสมอ · ตัวเลขจาก dry-run ตัดสินว่าคุ้ม) · ข้อความที่โดนลบฝั่ง Meta กู้ไม่ได้
- **ของเก่า LINE** — เนื้อไฟล์เกินเวลาหมดแล้วกู้ไม่ได้ตามข้อกำหนดของ LINE → UI แสดงป้าย `[รูป/ไฟล์เดิม · กู้คืนไม่ได้]` แทนรูปใหญ่แล้ว
- **Avatar หมดอายุ 13 ต.ค. 2026** — `core.contact.picture_url` ของ Messenger ยังเป็น URL lookaside ดิบ ๆ งานถัดไปควรกาฝาก avatar ด้วยกลไกเดียวกัน (ตารางเดียวกับ profile refresh)
- **asher-web** — ใช้ `/api/media` ของเว็บตัวเอง ตรวจผู้ใช้แล้วส่ง access token ไปยัง media proxy ของ Connect; ไม่ต้องล็อกอิน Connect ซ้ำ และไม่ส่ง service key ไปที่ browser
- **ขนาดพื้นที่** — ยังไม่มี retention policy; วัดจาก `select pg_size_pretty(coalesce(sum((m->>'bytes')::bigint),0)::bigint) from inbox.message cross join lateral jsonb_array_elements(media) m;` และวัด Storage volume ประกอบ เพราะ query ไม่นับ object ที่ยังผูกกับข้อความไม่สำเร็จ

## 6. ตรวจต่อจาก handoff (2026-09-16)

พบและแก้เพิ่มเติมก่อน deploy:

- SQL เดิมสร้างแต่ `connect_private.media_*` ขณะที่ `rpcDirect` เรียก schema `inbox`; ต้องมี RPC wrapper ที่ schema `inbox` พร้อม ACL
- ข้อความที่ดึงผ่าน `messages` (polling/โหลดข้อความเก่า) ต้องเติม media เหมือน `detail` ไม่เช่นนั้นรูปจะหายหลัง refresh
- LINE external content ถูกทิ้งระหว่าง normalization; regression test ใช้ webhook ผ่าน `normalizeWebhook` จริงและยืนยันงานเป็น URL
- Media proxy ต้องตรวจสิทธิ์ปัจจุบันก่อนอ่านไฟล์ ไม่ใช่ตรวจเพียงว่ามี session; ไฟล์ชนิด active content ต้องเสิร์ฟเป็น attachment พร้อม nosniff/sandbox
- ข้อความไม่มี media ยังสรุปไม่ได้ว่าเป็นของเก่าที่กู้คืนไม่ได้ เพราะอาจกำลังดาวน์โหลด; UI ใช้ป้าย "รูป/ไฟล์แนบยังไม่พร้อม"

ผลทดสอบและสถานะ deploy ให้ดูรายงาน `docs/media-pipeline-verification.md` ซึ่งแยกการทดสอบ local ออกจากการยืนยันบน production
