# ---------- Base ----------
FROM node:22-slim AS base

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && \
    apt-get install -y \
      tini \
      wget \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*


# ---------- Dependencies ----------
FROM base AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# Install all dependencies including optional native binaries.
# Then explicitly add the Linux-native packages Turbopack/Tailwind need at build time.
RUN npm ci --include=optional --foreground-scripts && \
    npm install --no-save \
      @tailwindcss/oxide-linux-x64-gnu@4.3.2 \
      lightningcss-linux-x64-gnu@1.33.0


# ---------- Builder ----------
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

RUN npm run build


# ---------- Runner ----------
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN groupadd --system nodejs && \
    useradd --system \
      --gid nodejs \
      --home-dir /app \
      --shell /usr/sbin/nologin \
      nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
CMD wget -qO- http://127.0.0.1:${PORT}/api/health | grep -q '"message":"ok"' || exit 1

ENTRYPOINT ["tini","-s","--"]
CMD ["node","server.js"]