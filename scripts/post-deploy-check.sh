#!/usr/bin/env bash
# ตรวจหลัง deploy ว่าทำไม "ยังไม่เห็นการเปลี่ยนแปลง" — รันบน VPS ครั้งเดียวแล้วส่งผลทั้งหมดกลับมา
#
#   bash post-deploy-check.sh [ไฟล์ที่ต้องเห็น=case-flags] [rpc ที่ต้องมี=tags_list]
#
# แก้อย่างเดียวที่ทำ: สั่ง PostgREST โหลดรายชื่อฟังก์ชันใหม่ (notify pgrst) — ปลอดภัย ไม่แตะข้อมูล
# ที่เหลืออ่านอย่างเดียว · ไม่พิมพ์ key/secret ออกมา
set -uo pipefail

MARK="${1:-case-flags}"
RPC="${2:-tags_list}"
APP="${APP:-/opt/asher-inbox/app}"
PORT="${PORT:-3200}"
DOMAIN="${DOMAIN:-inbox.apluscondo.com}"
verdict=()

say() { printf '\n== %s\n' "$*"; }
envval() { grep -E "^$1=" "$APP/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

say "1 ตัวที่รันอยู่"
echo "deployed: $(cat "$APP/.deployed-commit" 2>/dev/null)"
docker ps --format '{{.Names}}  {{.Status}}  {{.Ports}}' | grep -i 'asher-connect' || echo "ไม่เจอ container asher-connect"
docker inspect asher-connect --format 'image created: {{.Created}}' 2>/dev/null

say "2 โค้ดใหม่ถูกเสิร์ฟไหม (ในเครื่อง vs ผ่านโดเมน)"
LOCAL=$(curl -s "http://127.0.0.1:$PORT/app.js" | grep -c "$MARK")
PUBLIC=$(curl -s "https://$DOMAIN/app.js" | grep -c "$MARK")
echo "app.js มี '$MARK' — ในเครื่อง: $LOCAL · ผ่าน $DOMAIN: $PUBLIC"
echo "header ผ่านโดเมน:"
curl -sI "https://$DOMAIN/app.js" | grep -iE '^(server|cache-control|age|cf-|x-cache|via|etag|last-modified)' | sed 's/^/  /'
[ "$LOCAL" -gt 0 ] || verdict+=("container ยังเสิร์ฟ app.js ตัวเก่า — deploy ยังไม่ลงจริง")
[ "$LOCAL" -gt 0 ] && [ "$PUBLIC" -eq 0 ] && verdict+=("โดเมนไม่ได้วิ่งมาที่ container นี้ หรือมี cache ขวางอยู่ (ดูหัวข้อ 3)")

say "3 อะไรรับโดเมนนี้อยู่"
docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' | grep -E '0\.0\.0\.0:(80|443)->|:80->|:443->' | sed 's/^/  /' || true
grep -rlsI "$DOMAIN" /etc/nginx /etc/caddy /etc/traefik /opt 2>/dev/null | grep -v -E '/(node_modules|app\.bak-[0-9-]+)/|\.sql$|\.md$' | head -10 | while read -r f; do
  echo "  $f"; grep -nE "proxy_pass|reverse_proxy|upstream|server_name|$DOMAIN|:$PORT|asher" "$f" 2>/dev/null | head -8 | sed 's/^/      /'
done

say "4 ฟังก์ชันในฐาน"
docker exec supabase-db psql -U postgres -d postgres -Atc "
select 'functions '||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='inbox' and p.proname in ('case_star','case_follow','case_tags_set','tags_list','tag_upsert','tag_archive','case_flags','flag_list');
select 'tags '||count(*) from connect_private.tag where is_active;" 2>&1 | sed 's/^/  /'

say "5 PostgREST เห็นฟังก์ชันใหม่ไหม"
SB_URL=$(envval SUPABASE_URL); ANON=$(envval SUPABASE_ANON_KEY)
probe() {
  curl -s -o /tmp/pgrst-probe.json -w '%{http_code}' -X POST "$SB_URL/rest/v1/rpc/$RPC" \
    -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' \
    -H 'Content-Profile: inbox' -H 'Accept-Profile: inbox' -d '{"p":{}}'
}
if [ -z "$SB_URL" ] || [ -z "$ANON" ]; then
  echo "  อ่าน SUPABASE_URL / SUPABASE_ANON_KEY จาก .env ไม่ได้ — ข้าม"
else
  # ★ ด้วย anon key ฟังก์ชันที่มีอยู่จริงต้องตอบ 401/403 (ไม่มีสิทธิ์) ไม่ใช่ 404 (หาไม่เจอ)
  code=$(probe); echo "  ก่อน reload: $code $(head -c 160 /tmp/pgrst-probe.json)"
  if [ "$code" = 404 ]; then
    docker exec supabase-db psql -U postgres -d postgres -qc "notify pgrst, 'reload schema'" && echo "  สั่ง reload schema แล้ว"
    sleep 4; code=$(probe); echo "  หลัง reload: $code $(head -c 160 /tmp/pgrst-probe.json)"
    [ "$code" = 404 ] && verdict+=("PostgREST ยังหา inbox.$RPC ไม่เจอหลัง reload — ต้องดู schema ที่ PostgREST เปิดไว้") \
                      || verdict+=("PostgREST เพิ่งเห็นฟังก์ชันใหม่หลัง reload — ลองรีเฟรชหน้าเว็บอีกครั้ง")
  fi
fi

say "6 error ล่าสุดของแอป (ตัด schema_version_latest ที่มีอยู่ก่อนแล้ว)"
docker logs --since 20m asher-connect 2>&1 | grep -v schema_version_latest | grep -iE 'error|fail|PGRST|not_found|42501' | tail -12 | sed 's/^/  /'

say "สรุป"
if [ ${#verdict[@]} -eq 0 ]; then
  echo "ฝั่ง server ปกติ — ถ้ายังไม่เห็นบนเว็บ ให้ Ctrl+Shift+R หรือเปิดหน้าต่างส่วนตัว แล้วส่ง screenshot มา"
else
  printf -- '- %s\n' "${verdict[@]}"
fi
