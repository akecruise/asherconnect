#!/usr/bin/env bash
set -euo pipefail

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:\Users\ADMin\asher-quick-replies-complete\scripts\export-line-session.ps1'

cookie_path='/mnt/c/Users/ADMin/AppData/Local/AsherLineRenewChrome/line-cookies.json'
test -s "$cookie_path"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  for candidate in /home/cheiwchan/.nvm/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]]; then node_bin="$candidate"; fi
  done
fi
if [[ -z "$node_bin" ]]; then echo 'Node.js is unavailable for LINE session validation' >&2; exit 127; fi
"$node_bin" /mnt/c/Users/ADMin/asher-quick-replies-complete/scripts/validate-line-session.mjs "$cookie_path"
scp -q "$cookie_path" root@187.53.139.175:/opt/asher-inbox/secrets/line-oa-cookies.json.tmp
ssh -o BatchMode=yes root@187.53.139.175 'chmod 600 /opt/asher-inbox/secrets/line-oa-cookies.json.tmp && mv /opt/asher-inbox/secrets/line-oa-cookies.json.tmp /opt/asher-inbox/secrets/line-oa-cookies.json'
