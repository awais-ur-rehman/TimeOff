# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:timeoff

FROM node:20-alpine

RUN apk add --no-cache curl python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

RUN apk del python3 make g++ && rm -rf /var/cache/apk/*

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/apps/timeoff-service/main"]
