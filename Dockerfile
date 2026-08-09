# syntax=docker/dockerfile:1

# ---- deps -------------------------------------------------------------------
# Installed in its own stage so the final image carries no npm cache or lockfile
# churn — only the resolved node_modules tree.
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# node_modules is a runtime dependency in more than the usual sense: server.js
# serves Leaflet's dist straight out of it at /vendor/leaflet.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public

# PID 1 gets no default signal disposition from the kernel, and server.js installs
# no SIGTERM handler — so as PID 1 node would ignore `docker stop` and eat the full
# 10s grace period before SIGKILL. tini takes PID 1 and forwards the signal to node,
# which then applies the default disposition and exits immediately.
RUN apk add --no-cache tini

# The stock `node` user from the base image — never run as root.
USER node

EXPOSE 3000

# /api/config is the cheapest endpoint that proves the app is actually serving.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/config" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

# Exec form, no npm wrapper, so tini execs node directly with no shell in between.
CMD ["node", "server.js"]
