# Handoff — ใบเสนอราคา PNG สำเร็จรูปต่อห้อง + Quick Reply ลื่นขึ้น (29 ก.ย. 2569)

งานนี้แก้สองระบบคู่กัน: **ASHER Connect** (repo นี้ branch `feature/quotation-png-store`)
และ **ASHER CRM** (`D:\aplus_postgres_docker\asher-crm-unit-png` branch `feature/unit-quotation-png`)
ไฟล์นี้มีเหมือนกันทั้งสอง repo

## ปัญหาตั้งต้น
"กดปุ่มไม่ลื่นเหมือน LINE" ตอนใช้ Quick Reply และออกใบเสนอราคาใน inbox.apluscondo.com

สาเหตุที่พบ:
- **ใบเสนอราคา**: กดแล้วรอ CRM สร้าง PDF ให้เสร็จ และทุกครั้งที่มีคนเปิดรูป (ทั้ง LINE, Messenger และหน้าแชท) CRM ต้องวาด PNG ใหม่
  ด้วย sharp พร้อมแปลน JPG ขนาด 2 MB สองไฟล์ ใช้เวลา 1.4–2 วินาทีต่อครั้ง และไม่เก็บไว้เลย (`no-store`)
  ระหว่างรอไม่มีสถานะกำลังโหลด เปิดแท็บใหม่ว่าง ๆ และล็อกปุ่มไว้จนแชทกับรายการเคสโหลดใหม่เสร็จ
- **Quick Reply บนมือถือ**: เปิดแผงแล้วคีย์บอร์ดเด้งขึ้นเอง (focus ช่องค้นหา) เลือกคำตอบแล้วคีย์บอร์ดเด้งอีกรอบ
  รายการถูกวาดใหม่สองรอบทุกครั้งที่เปิด และไม่มี pressed state ตอนแตะ

## ★ ต้องรู้ก่อนแตะ repo
- **prod ทั้ง Connect และ CRM เคยรันโค้ดที่ไม่อยู่ใน git** — `.deployed-commit` ของ Connect บอก `fe29fea`
  แต่ไฟล์จริงต่างไป 18 ไฟล์ งานนี้จึงดึงของจริงจาก VPS มาเก็บเป็น commit แรกก่อนแก้
  (Connect `20a7799`, CRM `c9b3395`)
- **ห้าม deploy Connect จาก branch `connect-profile-content`** (worktree หลัก `asher-connect`) เป็นอีกเวอร์ชัน
  ถ้าขึ้นไป ฟีเจอร์ใบเสนอราคาบน prod จะหาย
- compose ของ Connect และ CRM ใช้ project name `app` เหมือนกัน

## สิ่งที่ทำ

### Connect
| commit | เรื่อง |
|---|---|
| `20a7799` | snapshot ของ prod release `20260928T143000Z-quotation-png` |
| `002628a` | `/quotation-image/<id>` (ใบที่มีชื่อลูกค้า) ดึงจาก CRM ครั้งเดียวแล้วเก็บที่ inbox-media `quotation/<id>.png` · `lib/quotation-image.mjs` |
| `f9ae642` | Quick Reply: ไม่ focus บนจอสัมผัส · วาดรายการใหม่เฉพาะเมื่อข้อมูลเปลี่ยน · pressed state · กล่องเลือกห้องขึ้นทันทีพร้อม "กำลังโหลด" · ไม่เปิดแท็บใหม่ · ปลดล็อกปุ่มทันทีหลังส่ง |
| `5f102da` | ใบสำเร็จรูปต่อห้อง: `lib/unit-quotation-images.mjs` เตรียมรูปทุกห้องว่างที่มีราคาไว้ที่ `outbound/unit-quote-<unit>-<version>.png` · action `quotation_unit_png` ส่งผ่าน `send_image` + ลิงก์ `/outbound-media/` ที่เซ็นไว้ · ห้องที่รอราคาไม่แสดงในรายการ |

รอบการเตรียมรูป: 20 วินาทีหลังบูต ทุก 15 นาที และทุกครั้งที่เซลส์เปิดหน้าต่างเลือกห้อง
ตอนกดส่ง ถ้ารายการราคาเก่าเกิน 2 นาที จะขอรายการใหม่ (แค่รายการ ไม่ได้วาดรูป) กันส่งราคาที่เพิ่งเปลี่ยน
รูปรุ่นเก่าไม่ลบ เพราะลิงก์ที่ส่งหาลูกค้าไปแล้วต้องเปิดได้ต่อ

### CRM
| commit | เรื่อง |
|---|---|
| `c9b3395` | snapshot ของ prod release `20260928T161500Z-quotation-default-png` (รวม `quotations.ts` และแปลน 41 MB ที่ไม่เคย commit) |
| `4e5ce3d` | endpoint service-only สำหรับ Connect: `GET /api/integrations/connect/unit-quotation-images` (รายการห้อง + `quotation_version`) และ `GET /api/integrations/connect/units/:id/quotation-image` |
| `f04fd21` | หน้าตาใบใหม่ เรียงหมวด ห้อง → ราคา → แผนชำระ → ค่าใช้จ่ายวันโอน → ของแถม/เงื่อนไข → หมายเหตุ → ลงชื่อ ความสูงเปลี่ยนตามเนื้อหา · เงื่อนไขอ่านจาก `src/assets/quotation-terms.json` |
| `8fe7d08` | CRM เก็บ PNG ต่อห้องเองใน `crm-documents/unit-quotations/<ws>/<unit>-<version>.png` · แผงรายละเอียดห้อง (Unit inventory) แสดงรูปใบของห้องนั้น ผ่าน `/api/crm/units/:id/quotation-preview` |
| `41014ec` | ชุดเงื่อนไขมาตรฐาน `match: "*"` ใช้กับทุกห้อง |
| `d3b3919` | ติดต่อฝ่ายขาย: โทร 088-088-8449 · LINE @ashercondo |
| (commit นี้) | อายุราคาไม่มีวันหมดอายุตายตัว: ฟิลด์ใหม่ `validity_note` แสดงแทน `valid_until` |

`quotation_version` คือ hash ของทุกอย่างที่อยู่บนรูป: ข้อมูลห้อง, ราคา, แปลน, เงื่อนไขของโครงการ, สถานะว่าราคายังไม่หมดอายุ
และ `UNIT_QUOTATION_TEMPLATE` (เปลี่ยนหน้าตารูปเมื่อไร ให้ bump ตัวนี้)

## การตัดสินใจของผู้ใช้
- ใบที่ส่งจาก Connect เป็น **PNG สำเร็จรูปต่อห้อง ไม่มีชื่อลูกค้า เลขที่ใบ หรือวันที่ออก** และไม่สร้าง record ใบเสนอราคาใน CRM
  (ปุ่ม "ออกใบเสนอราคาห้องนี้" ใน CRM ยังออกใบแบบใส่ชื่อ/เลขที่ได้เหมือนเดิม)
- รูปสำเร็จรูปไม่ใส่วันที่ออก ไม่อย่างนั้นต้องวาดใหม่ทุกวัน (ราว 1 GB ต่อเดือน)
- ใช้เงื่อนไข**ชุดเดียวกันทุกห้อง**

## เงื่อนไขมาตรฐานที่ใช้อยู่ (`src/assets/quotation-terms.json` ของ CRM)
- อายุราคา: "ราคา ณ ปัจจุบัน อาจมีการปรับเปลี่ยนในอนาคต" (`validity_note` — ผู้ใช้สั่ง ไม่ใช้วันหมดอายุตายตัว · ถ้าจะกลับไปใช้วันที่ ให้ใส่ `valid_until` แทน)
- เงินจอง 2,000 บาท ชำระ ณ วันจอง
- ผู้ซื้อจ่าย ณ วันโอน: ค่าส่วนกลาง 55 บาท/ตร.ม. × 12 เดือน · เงินกองทุน 500 บาท/ตร.ม.
- ของแถม: เฟอร์นิเจอร์ และเครื่องปรับอากาศ ตามรายการที่โครงการกำหนด
- สินเชื่อไม่ผ่าน: การคืนเงินจองเป็นไปตามนโยบายโครงการ
- ติดต่อ: โทร 088-088-8449 · LINE @ashercondo

ยังไม่มีข้อมูล จึงไม่แสดงในใบ: เงินทำสัญญา (จำนวนและกำหนดวัน), ค่าใช้จ่ายที่โครงการออกให้, จำนวนและขอบเขตของแถม
ไฟล์เงื่อนไขอยู่ใน image (Dockerfile `COPY src`) แก้แล้วต้อง build CRM ใหม่ จากนั้น Connect จะทำรูปใหม่เองภายใน 15 นาที

## สถานะ prod (29 ก.ย. 2569 ~10:00 น.)
- Connect: `releases/20260929T025604Z-quote-store-5f102da` · log `unit_quotation_prerendered total=35 made=35 failed=0`
- CRM: `releases/20260929T025550Z-unit-quotation-png-8fe7d08`
  → **`41014ec` ขึ้นไป (เงื่อนไขมาตรฐาน + ช่องทางติดต่อ + อายุราคา) ยังไม่ได้ deploy** tar อยู่ที่ `/tmp/crm-unit-png.tar` บน VPS
- ยังไม่ได้เช็คว่า bucket `crm-documents` รับ `image/png` ได้ไหม ถ้าไม่รับ CRM จะวาดใหม่ทุกครั้ง ภาพยังขึ้นแต่ช้า

## Deploy (ผู้ใช้รันเองบน VPS · ขั้นสร้าง tar + scp ทำจาก Windows ได้)
```bash
# CRM ก่อนเสมอ
cd /opt/asher-crm && OLD=$(readlink -f app) && NEW=releases/$(date -u +%Y%m%dT%H%M%SZ)-<name> && cp -a "$OLD" "$NEW" && tar -xf /tmp/crm-unit-png.tar -C "$NEW" && ln -sfn "$NEW" app && cd app && docker compose -f compose.production.yml up -d --build asher-crm
# แล้วค่อย Connect
cd /opt/asher-inbox && OLD=$(readlink -f app) && NEW=releases/$(date -u +%Y%m%dT%H%M%SZ)-<name> && cp -a "$OLD" "$NEW" && tar -xf /tmp/quote-store.tar -C "$NEW" && ln -sfn "$NEW" app && cd app && docker compose up -d --build
```
rollback: `ln -sfn <release เดิม> app` แล้ว `docker compose ... up -d --build`

## เทสต์
- Connect: `node --test tests/quotation-image.test.mjs tests/unit-quotation-images.test.mjs tests/quotation-link.test.mjs` ผ่านทั้งหมด
- CRM: `node --import tsx --test tests/unit/quotations.test.ts` ผ่าน 11/11 · `npx tsc --noEmit` ผ่าน
- **เทสต์ที่ล้มอยู่แล้วตั้งแต่ snapshot prod ก่อนแก้ (ไม่เกี่ยวงานนี้):**
  Connect `providers.test.mjs` (Instagram 1 ตัว), `media-http.test.mjs`, `outbound-media.test.mjs`
  และ `quick-replies-ui.test.mjs` 6/6 (เขียนไว้ให้ `quick-replies.js` อีกเวอร์ชัน)
- ยังไม่ได้ลองกดจริงบนมือถือ และยังไม่ได้เห็นหน้าแผงห้องใน CRM จริง (ในเครื่องไม่มีฐานข้อมูล CRM)

## งานค้าง
1. deploy CRM ชุดล่าสุดของ branch `feature/unit-quotation-png`
2. ขอข้อมูลจริงจากโครงการ: เงินทำสัญญา, ค่าใช้จ่ายที่โครงการออก, รายละเอียดของแถม
3. เช็ค mime type ที่ bucket `crm-documents` รับ
4. ทำ `.deployed-commit` บน VPS ให้ตรงของจริง หรือเลิกแก้ไฟล์บน prod ด้วยมือ
