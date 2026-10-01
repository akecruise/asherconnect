#!/usr/bin/env bash
# Deploy asher-connect บน VPS ตรง ๆ โดยดึงโค้ดจาก GitHub (repo public) — ไม่ต้องมี git/ssh บนเครื่อง
#
#   bash deploy-from-github.sh <commit ที่จะขึ้น> [sql/ไฟล์ที่ต้องลง ...]
#
# หยุดเองทุกครั้งที่ไม่แน่ใจ:
#   1. .deployed-commit ต้องตรงกับ EXPECT_LIVE (ตัวที่คิดว่ารันอยู่)
#   2. ไฟล์บนเครื่องต้องตรงกับ commit นั้น — ถ้ามีไฟล์ถูกแก้ด้วยมือ (เคยเกิดแล้ว ดู 20a7799)
#      วางทับไปจะทำของพวกนั้นหาย จึงหยุดแล้วพิมพ์รายชื่อให้ดูก่อน
#   3. ไฟล์หน้าเว็บใหม่ต้องตอบ 200 หลัง build — ไม่งั้นบอกวิธีย้อนกลับ
# ตามหลักใน docs/deploy.md: deploy จาก commit เท่านั้น · ไม่แตะ .env channels.json .sessions/
set -euo pipefail

COMMIT="${1:?ใส่ commit เต็ม 40 ตัวที่จะ deploy}"
shift
SQL_FILES=("$@")
APP="${APP:-/opt/asher-inbox/app}"
BASE=$(dirname "$APP")
REPO=akecruise/asherconnect
EXPECT_LIVE="${EXPECT_LIVE:-fc3c2be8a561643fa7d81fb1bf1aa79b747e65bc}"
PORT="${PORT:-3200}"
STAMP=$(date +%Y%m%d-%H%M%S)
WORK=/tmp/deploy-$STAMP

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! หยุด: %s\n' "$*" >&2; exit 1; }

[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "commit ต้องเป็น hash เต็ม 40 ตัว"
cd "$APP"

say "1/7 ตรวจตัวที่รันอยู่"
LIVE=$(cat .deployed-commit 2>/dev/null || echo none)
echo "รันอยู่: $LIVE"
[ "$LIVE" = "$COMMIT" ] && die "commit นี้รันอยู่แล้ว"
[ "$LIVE" = "$EXPECT_LIVE" ] || die "คาดว่าจะเป็น $EXPECT_LIVE — ส่งค่านี้ให้คนดูแลก่อน (หรือตั้ง EXPECT_LIVE=... ถ้ารู้ว่าถูก)"

say "2/7 ดึงโค้ดจาก GitHub"
mkdir -p "$WORK/live" "$WORK/new"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$LIVE" | tar -xz -C "$WORK/live" --strip-components=1
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$COMMIT" | tar -xz -C "$WORK/new" --strip-components=1
echo "ได้ $(find "$WORK/new" -type f | wc -l) ไฟล์"
for f in "${SQL_FILES[@]}"; do [ -f "$WORK/new/$f" ] || die "ไม่มี $f ใน commit นี้"; done

say "3/7 ตรวจว่าบนเครื่องไม่มีไฟล์ที่ถูกแก้ด้วยมือ"
DRIFT=$(diff -rq "$WORK/live" "$APP" -x .env -x channels.json -x .sessions -x node_modules -x .deployed-commit 2>&1 \
  | grep ' differ$' || true)
if [ -n "$DRIFT" ]; then
  echo "$DRIFT"
  die "ไฟล์ข้างบนบนเครื่องไม่ตรงกับ $LIVE — ส่งรายการนี้ให้คนดูแลก่อน ยังไม่ได้แก้อะไร"
fi
echo "ตรงกันหมด"

say "4/7 จุดย้อนกลับ (image + โฟลเดอร์ + ฐาน)"
docker tag app-asher-connect "app-asher-connect:rollback-$STAMP"
cp -a "$APP" "$APP.bak-$STAMP"
if [ ${#SQL_FILES[@]} -gt 0 ]; then
  docker exec supabase-db pg_dump -U postgres -d postgres -n connect_private -n inbox > "$BASE/pre-deploy-$STAMP.sql"
  echo "backup ฐาน: $BASE/pre-deploy-$STAMP.sql ($(du -h "$BASE/pre-deploy-$STAMP.sql" | cut -f1))"
fi
echo "image: app-asher-connect:rollback-$STAMP · โฟลเดอร์: $APP.bak-$STAMP"

say "5/7 ลง SQL"
for f in "${SQL_FILES[@]}"; do
  echo "-- $f"
  docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$WORK/new/$f"
done
[ ${#SQL_FILES[@]} -gt 0 ] || echo "(ไม่มี)"

say "6/7 วางโค้ดใหม่ + build"
tar -C "$WORK/new" -cf - . | tar -C "$APP" -xf -
echo "$COMMIT" > .deployed-commit
docker compose build && docker compose up -d

say "7/7 ตรวจหลัง deploy"
ok=1
for i in $(seq 1 20); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 3
done
for p in / /app.js /case-flags.mjs; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")
  echo "$p $code"
  [ "$code" = 200 ] || ok=0
done
docker ps --filter name=asher-connect --format '{{.Status}}'
if [ $ok = 1 ]; then
  printf '\nDEPLOY ผ่าน: %s\n' "$COMMIT"
else
  cat >&2 <<EOF

!! มีไฟล์ไม่ตอบ 200 — ย้อนแอปกลับทันที:
   cd $BASE && rm -rf $APP && mv $APP.bak-$STAMP $APP && cd $APP \\
     && docker tag app-asher-connect:rollback-$STAMP app-asher-connect && docker compose up -d
   (SQL ที่ลงไปเป็นการเพิ่มอย่างเดียว ไม่ต้องย้อน)
EOF
  exit 1
fi
