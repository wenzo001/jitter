# 前端构建阶段：Vue 3 + Vite
FROM oven/bun:1.4.4 AS frontend
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM oven/bun:1.4.4

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
COPY --from=frontend /app/web/dist ./web/dist
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    JITTER_CONFIG=/app/jitter.config.json \
    JITTER_DB_PATH=/app/data/app.db

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
