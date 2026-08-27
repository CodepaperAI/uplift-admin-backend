FROM oven/bun:1.3.14-alpine AS deps

WORKDIR /app
# Belt to the braces below: if the --production flag is ever dropped, this stops
# a Chromium download landing in the image rather than letting it in quietly.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json bun.lock ./
COPY prisma ./prisma/
# --production, because this image serves three route groups and can reach 15 of
# the 37 packages the fork inherited from seo-be. Installing the other 22 put
# their vulnerabilities on the deploy gate's desk: nine unfixable criticals on
# puppeteer, in an image with no Chromium and no code path that could launch it.
# scripts/check-admin-surface.ts fails the build if anything reachable from the
# entrypoint starts importing one of them, so this cannot rot into a runtime
# MODULE_NOT_FOUND.
RUN bun install --frozen-lockfile --production

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
