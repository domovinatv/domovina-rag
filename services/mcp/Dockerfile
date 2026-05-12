# Multi-stage build: builder kompajlira TS, runtime ima samo prod deps + dist.
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public ./public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --spider -q http://localhost:3000/health || exit 1

# Production default je HTTP transport (compose ovo nadjača preko MCP_TRANSPORT env-a).
ENV MCP_TRANSPORT=http
CMD ["node", "dist/index.js"]
