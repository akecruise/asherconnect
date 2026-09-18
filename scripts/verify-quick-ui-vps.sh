#!/usr/bin/env bash
set -euo pipefail
base=https://inbox.apluscondo.com
for path in / /health /quick-replies.js; do
  code=$(curl -ks -o /tmp/quick-ui$(echo "$path" | tr '/' '_') -w '%{http_code}' "$base$path")
  echo "$path $code"
done
grep -Fq 'ASHER Connect' /tmp/quick-ui_ && echo 'brand PASS'
grep -Fq 'quick-replies.js' /tmp/quick-ui_ && echo 'script-tag PASS'
grep -Fq 'Quick Replies picker' /tmp/quick-ui_quick-replies.js && echo 'script-content PASS'
docker ps --filter name=asher-connect --format 'container={{.Names}} status={{.Status}}'
