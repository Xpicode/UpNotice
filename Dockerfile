# TeamAnnounce — single image that serves the API and the web app.
#   docker compose up -d --build     → http://localhost:4000

# ---- Stage 1: build the React web app ----
FROM node:22-bookworm-slim AS webbuild
WORKDIR /build/app
# Skip the (large) Electron binary download; it is only needed for the desktop build.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build

# ---- Stage 2: install server dependencies (compiles the SQLite native module) ----
FROM node:22-bookworm-slim AS serverdeps
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Stage 3: runtime image ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=serverdeps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
# The server serves the web app from ../app/dist
COPY --from=webbuild /build/app/dist /app/app/dist

RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
VOLUME ["/app/server/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
