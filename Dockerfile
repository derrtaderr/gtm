# ---- Build Stage ----
# Use node:20-slim (Debian-based) instead of alpine to avoid musl libc
# incompatibilities with the Claude Agent SDK's native dependencies.
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Runtime Stage ----
FROM node:20-slim

WORKDIR /app

# Install dependencies needed by Claude Agent SDK and MCP servers
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Install production deps + pre-install the postgres MCP server globally
# so we don't need to download it via npx at runtime
RUN npm ci --omit=dev \
  && npm install -g @modelcontextprotocol/server-postgres

COPY --from=builder /app/dist ./dist

# Copy non-TS assets that the runtime needs
COPY src/prompts ./dist/prompts
COPY src/config ./dist/config

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
