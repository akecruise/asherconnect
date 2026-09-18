import fs from 'node:fs'
const p='public/index.html'
let s=fs.readFileSync(p,'utf8')
if(!s.includes('id="quick-replies"')) s=s.replace('<button type="button" id="attach"','<button type="button" id="quick-replies" class="composer-attach" aria-label="Quick replies">⌘</button><button type="button" id="attach"')
if(!s.includes('/quick-replies.js')) s=s.replace('<script type="module" src="/app.js"></script>','<script type="module" src="/app.js"></script><script src="/quick-replies.js" defer></script>')
fs.writeFileSync(p,s,'utf8')
