# Deploy ขึ้น VPS

**หลักการเดียวที่ห้ามละเมิด: deploy จาก commit เท่านั้น ไม่ใช่จาก working tree**

`/opt/asher-inbox/app` **ไม่ใช่ git repo** (ไม่มี `.git`) วิธีเดิมคือ `scp` จาก working tree ตรง ๆ
ซึ่งพาของที่ยังไม่ commit ขึ้นโปรดักชันไปด้วยทุกครั้งโดยไม่มีอะไรฟ้อง

---

## สภาพบน VPS

| | |
|---|---|
| โฟลเดอร์ | `/opt/asher-inbox/app` |
| compose project | `app` · container `asher-connect` |
| image | `app-asher-connect` (build จากโฟลเดอร์นั้น) |
| **ไฟล์ที่ไม่ได้มาจาก repo — ห้ามทับเด็ดขาด** | `.env` · `channels.json` · `.sessions/` |

`Dockerfile` `COPY` เฉพาะ: `package.json` `server.mjs` `providers.mjs` `auth.mjs` `bots/` `reports/` `public/` `lib/` `scripts/`
(`sql/` `tests/` `docs/` ไม่เข้า image — ลงฐานแยกต่างหาก)

---

## ขั้นตอน

### 1. จดจุดย้อนกลับก่อนเสมอ

```bash
ssh root@187.53.139.175 '
  cd /opt/asher-inbox/app
  echo "image id ปัจจุบัน: $(docker inspect asher-connect --format "{{.Image}}")"
  docker tag app-asher-connect app-asher-connect:rollback-$(date +%Y%m%d-%H%M%S)
  docker images app-asher-connect --format "  {{.Tag}}  {{.ID}}  {{.CreatedSince}}"
  cp -a . "../app.bak-$(date +%Y%m%d-%H%M%S)"
  ls -d ../app.bak-* | tail -3'
```

### 2. สร้าง archive จาก commit (working tree ไม่เกี่ยวเลย)

```bash
cd /d/aplus_postgres_docker/asher-connect
COMMIT=$(git rev-parse HEAD)          # หรือระบุ hash/branch ที่ต้องการ
git archive --format=tar "$COMMIT" > /tmp/deploy-$COMMIT.tar

# ★ ดูก่อนส่ง ว่ามีเฉพาะของที่ commit แล้ว
tar -tf /tmp/deploy-$COMMIT.tar | head -30
tar -tf /tmp/deploy-$COMMIT.tar | wc -l
```

`git archive` อ่านจาก object ของ commit ล้วน — **ของที่ยังไม่ commit ไม่มีทางหลุดขึ้นไป**

### 3. ส่งและแตกทับ

```bash
scp /tmp/deploy-$COMMIT.tar root@187.53.139.175:/tmp/
ssh root@187.53.139.175 "
  cd /opt/asher-inbox/app
  tar -xf /tmp/deploy-$COMMIT.tar        # แตกทับ ไม่ลบไฟล์ที่ไม่ได้อยู่ใน tar
  echo '$COMMIT' > .deployed-commit      # จดว่าตอนนี้รัน commit ไหน
  rm -f /tmp/deploy-$COMMIT.tar"
```

`tar -xf` เขียนทับเฉพาะไฟล์ที่อยู่ใน archive — `.env` `channels.json` `.sessions/` ไม่ถูกแตะ
(ทั้งสามไม่มีใน git จึงไม่มีใน archive)

### 4. build และใช้งาน

```bash
ssh root@187.53.139.175 '
  cd /opt/asher-inbox/app
  docker compose build && docker compose up -d'
```

`docker compose up -d` เท่านั้น — `docker restart` ไม่โหลด `.env` ใหม่

### 5. ตรวจหลัง deploy

```bash
sleep 8
ssh root@187.53.139.175 '
  curl -s localhost:3200/health | head -c 200; echo
  docker logs asher-connect --since 2m 2>&1 | grep -iE "error|failed" | head'
```

---

## ย้อนกลับ

```bash
ssh root@187.53.139.175 '
  cd /opt/asher-inbox/app
  docker images app-asher-connect --format "{{.Tag}} {{.ID}}"      # หา tag rollback-*
  docker tag app-asher-connect:rollback-<ที่จด> app-asher-connect:latest
  docker compose up -d --force-recreate'
```

ถ้าต้องย้อนไฟล์ด้วย:

```bash
ssh root@187.53.139.175 '
  cd /opt/asher-inbox
  ls -d app.bak-*        # เลือกอันที่ต้องการ
  rsync -a --delete --exclude .env --exclude channels.json --exclude .sessions \
        app.bak-<ที่เลือก>/ app/
  cd app && docker compose build && docker compose up -d'
```

⚠️ `--exclude` สามตัวนั้นห้ามลืม ไม่งั้นทับ `.env` ของจริงด้วยสำเนาเก่า

---

## ห้าม

- `scp` ไฟล์เดี่ยว ๆ จาก working tree ขึ้นโปรดักชัน
- `rsync` ทั้งโฟลเดอร์โดยไม่ `--exclude .env channels.json .sessions`
- `docker restart` แทน `docker compose up -d` เมื่อแก้ `.env`
