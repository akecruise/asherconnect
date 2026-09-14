FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs providers.mjs ./
# bots/ ต้องเข้า image ด้วย — server.mjs อ่านข้อมูลโครงการจาก bots/project-data/ ตอนบูต
# ถ้าลืมบรรทัดนี้ container จะขึ้นไม่ได้เลย (ไม่ใช่ขึ้นแล้วบอทเงียบ)
COPY --chown=node:node bots ./bots
COPY --chown=node:node public ./public
USER node
ENV PORT=3200 NODE_ENV=production
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# เพดาน heap ต่ำกว่า mem_limit ของ container อยู่หนึ่งช่วง (160 vs 256 MB)
# เพื่อให้ V8 เริ่มเก็บกวาดก่อนที่ kernel จะฆ่าโพรเซสทิ้ง
# ถูก OOM kill = ไม่มี log ไม่มีอะไรให้ดูว่าตอนนั้นทำอะไรอยู่
CMD ["node", "--max-old-space-size=160", "server.mjs"]
