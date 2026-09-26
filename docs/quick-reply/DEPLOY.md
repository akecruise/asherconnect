# Deploy — Quick Reply + คลังรูป

branch `feature/quick-reply-image-library` · ขั้นตอนหลักตาม `docs/deploy.md` (deploy จาก commit เท่านั้น)

## ★ ก่อนเริ่ม: server.mjs บน VPS ไม่ตรงกับ commit ใดเลย

ตรวจ 2026-09-26 ด้วย sha256:

| ไฟล์บน VPS | ตรงกับ |
|---|---|
| `public/app.js`, `public/quick-replies.js`, `public/quick-replies-admin.js`, `providers.mjs`, `lib/outbound-media.mjs`, `lib/profile.mjs` | release `8b682cd` (ฐานของ branch นี้) |
| `lib/quick-reply-media.mjs` | worktree naii-media 25 ก.ย. |
| `lib/media-public.mjs`, `lib/instagram.mjs` | **ไม่มีใน git** |
| `server.mjs` (a3f88a16…, แก้ 25 ก.ย. 17:05 UTC) | **ไม่ตรงกับไฟล์ใดในเครื่อง** |

→ ถ้าแตก tar ของ branch นี้ทับเลย จะลบการแก้ server.mjs ที่ไม่ได้อยู่ใน git ทิ้ง
**ต้องดึง server.mjs/lib ของ VPS ลงมา diff กับ `8b682cd` แล้วรวมเข้า branch ก่อน**:

```bash
ssh root@187.53.139.175 "cd /opt/asher-inbox/app && tar cf - server.mjs providers.mjs lib public" > /d/aplus_postgres_docker/prod-snapshot-20260926.tar
```

(Claude อ่านไฟล์บน production เองไม่ได้ — ติดกฎ Production Reads ต้องให้คนรันคำสั่งนี้)

## 1. Backup (บน VPS)

```bash
ssh root@187.53.139.175 '
  set -e; TS=$(date +%Y%m%d-%H%M%S); B=/opt/asher-inbox/backup-media-library-$TS; mkdir -p $B
  docker tag app-asher-connect app-asher-connect:before-media-library-$TS
  cp -a /opt/asher-inbox/app $B/app
  docker exec supabase-db pg_dump -U postgres -d postgres -Fc \
    -t inbox.media_asset -t inbox.quick_reply -t inbox.quick_reply_attachment > $B/before-media-library.dump
  docker exec -i supabase-db pg_restore --list < $B/before-media-library.dump | head -5
  echo $B'
```

## 2. SQL (รันด้วยมือ ตามลำดับ)

```bash
scp sql/202609261000_media_library.sql root@187.53.139.175:/tmp/
ssh root@187.53.139.175 'docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < /tmp/202609261000_media_library.sql'
```

- ทั้งไฟล์อยู่ใน `begin … commit` ล้มกลางทาง = ไม่มีอะไรเปลี่ยน · รันซ้ำได้
- ไม่แตะ `connect_private.api` และ `qr_*` เดิม — ไม่ต้องเทียบ live function
- selftest (ROLLBACK ทั้งไฟล์):
  `docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set asher.allow_db_tests=1" -f - < sql/_selftest/202609261000_media_library_selftest.sql`
- PostgREST ต้องโหลด schema cache ใหม่: `docker exec supabase-db psql -U postgres -c "notify pgrst, 'reload schema'"`

## 3. โค้ด

ไฟล์ที่เปลี่ยน/เพิ่ม (Dockerfile COPY `lib/` `public/` อยู่แล้ว ไม่ต้องแก้):

- `server.mjs` · `lib/media-library.mjs` (ใหม่)
- `public/app.js` · `public/quick-replies.js` · `public/index.html`
- `public/image-library.js` · `public/media-library.{html,js,css}` (ใหม่)

ขั้นตอน archive → scp → `tar -xf` → `docker compose build && docker compose up -d` ตาม `docs/deploy.md` ข้อ 2–4
(tar ต้องมี `lib/` — ลืมแล้ว boot ตาย)

ไม่มีค่า `.env` ใหม่

## 4. ตรวจหลัง deploy

- `curl -s localhost:3200/health` · `docker logs asher-connect --since 2m | grep -iE "error|failed"`
- ทำตาม `TEST-CHECKLIST.md` หัวข้อ "บน production"

## ย้อนกลับ

1. โค้ด: `docker tag app-asher-connect:before-media-library-<TS> app-asher-connect:latest && docker compose up -d --force-recreate`
   แล้ว rsync `$B/app/` กลับ (`--exclude .env --exclude channels.json --exclude .sessions`)
2. ฐาน: ไม่ต้องถอย — คอลัมน์/ฟังก์ชันใหม่ไม่ถูกเรียกจากโค้ดเก่า
   ถ้าจำเป็นจริง: `drop function inbox.media_list(...)` ฯลฯ + `drop table inbox.media_asset_send` (คอลัมน์ใหม่ใน media_asset ทิ้งไว้ได้)
