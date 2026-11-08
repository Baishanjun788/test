FROM node:20-alpine

WORKDIR /app

# 零依赖，package.json 只为声明版本要求
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

# 用内置的 healthz 做健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
