FROM node:24-trixie-slim AS frontend

WORKDIR /usr/src/app

# Copy package files first so dependency installs are cached between builds
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ .
RUN npm run build

FROM node:24-trixie-slim AS backend

WORKDIR /usr/src/app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-trixie-slim

LABEL org.opencontainers.image.source=https://github.com/joshuawowk/t630-web-fan-manager
LABEL org.opencontainers.image.description="Dell iDRAC fan controller and sensor monitor"

# Debian's ipmitool, not Alpine's: the Alpine 1.8.19 build segfaults on `ipmitool sensor` against Dell
# iDRACs (Danielv123/serverManager#93), which leaves the app without temperatures
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ipmitool \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY --from=backend /usr/src/app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY --from=frontend /usr/src/app/build ./build

EXPOSE 8080

# Unhealthy when the control loop stalls, a server has not been read for 5 minutes, or a server is in failsafe
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# node directly rather than `npm start`, so SIGTERM reaches the app and it can hand the fans back to the iDRAC
CMD [ "node", "src/index.js" ]
