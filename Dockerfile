# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Runtime Stage ----
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Copy non-TS assets that the runtime needs
COPY src/prompts ./dist/prompts
COPY src/config ./dist/config

EXPOSE 3000

CMD ["node", "dist/server.js"]
