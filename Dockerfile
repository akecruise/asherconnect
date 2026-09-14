FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs providers.mjs ./
COPY --chown=node:node public ./public
USER node
ENV PORT=3200 NODE_ENV=production
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
