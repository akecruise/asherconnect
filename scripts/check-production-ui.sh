#!/usr/bin/env bash
set -euo pipefail
echo 'CONTAINERS'; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
echo 'MOUNTS'; docker inspect asher-connect --format '{{json .Mounts}}' 2>/dev/null || true
echo 'COMPOSE'; find /opt/asher-inbox -maxdepth 3 -type f \( -name docker-compose.yml -o -name compose.yml -o -name index.html -o -name quick-replies.js \) -print
echo 'HTTP'; for p in / /quick-replies.js; do curl -ks -o /tmp/prod$(echo "$p" | tr '/' '_') -w "$p %{http_code}\n" "https://inbox.apluscondo.com$p"; done
echo 'HTML_MARKERS'; grep -o 'id="quick-replies"' /tmp/prod_ || true; grep -o '/quick-replies.js[^" ]*' /tmp/prod_ || true; grep -o 'id="template-menu"' /tmp/prod_ || true; grep -o 'id="message"' /tmp/prod_ || true
echo 'SCRIPT_MARKER'; grep -F 'Quick Replies picker' /tmp/prod_quick-replies.js || true
echo 'PROCESS'; docker exec asher-connect sh -lc 'pwd; ps -ef | head -20'
