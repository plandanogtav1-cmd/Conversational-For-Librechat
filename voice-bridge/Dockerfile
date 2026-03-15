# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json ./
RUN npm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies
RUN npm prune --production

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Non-root user
RUN addgroup --system bridge && adduser --system --ingroup bridge bridge
USER bridge

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
