#!/usr/bin/env bash
set -euo pipefail
app=/opt/asher-inbox/app
backup=/opt/asher-inbox/app.bak-quick-ui-$(date -u +%Y%m%d%H%M%S)
cp -a "$app" "$backup"
tar -xzf /tmp/asher-connect-quick-ui.tar.gz -C "$app"
cd "$app"
docker compose build asher-connect
docker compose up -d asher-connect
for i in $(seq 1 20); do
  code=$(curl -ks -o /tmp/asher-health.json -w '%{http_code}' https://inbox.apluscondo.com/health || true)
  if [ "$code" = 200 ]; then cat /tmp/asher-health.json; exit 0; fi
  sleep 2
done
echo "health failed; rolling back application files" >&2
docker compose stop asher-connect || true
rm -rf "$app"
mv "$backup" "$app"
cd "$app"
docker compose up -d asher-connect
exit 1
