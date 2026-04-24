# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

# Build tools needed to compile better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:timeoff

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/apps/timeoff-service/main"]
