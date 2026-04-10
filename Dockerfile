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

# Install dependencies needed by Claude Agent SDK and MCP servers
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create app dir with the non-root `node` user (UID 1000, built into the image)
WORKDIR /app
RUN chown -R node:node /app

USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node --from=builder /app/dist ./dist

# Copy non-TS assets that the runtime needs
COPY --chown=node:node src/prompts ./dist/prompts
COPY --chown=node:node src/config ./dist/config

# Claude Code SDK requires HOME to point to a writable dir
# /home/node is created by the base image and owned by `node`
ENV HOME=/home/node
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
