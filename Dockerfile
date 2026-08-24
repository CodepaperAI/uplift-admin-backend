FROM oven/bun:1.3.14-alpine AS deps

WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json bun.lock ./
COPY prisma ./prisma/
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-alpine AS runner

WORKDIR /app
RUN apk add --no-cache ca-certificates openssl

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=deps --chown=bun:bun /app/prisma ./prisma
COPY --chown=bun:bun . .
RUN DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma" \
    bunx prisma generate

ENV NODE_ENV=production
EXPOSE 3000
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health/live || exit 1

CMD ["bun", "run", "start"]
