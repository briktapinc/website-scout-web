FROM node:22.23.3-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562 AS runtime
ARG SOURCE_DATE_EPOCH=1792454400
ARG DEBIAN_SNAPSHOT=20261020T000000Z

WORKDIR /app

# Native build tools + Chromium for site preview screenshots (Puppeteer).
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && apt-get -o Acquire::Retries=5 -o Acquire::https::Timeout=30 update && apt-get -o Acquire::Retries=5 -o Acquire::https::Timeout=30 install -y --no-install-recommends \
    python3 make g++ \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev --no-audit --fund=false

COPY server.js ./
COPY server ./server
COPY src ./src
COPY sql ./sql
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV DB_DRIVER=mysql
ENV EXPORT_ROOT=/var/lib/website-scout-exports
ENV WORKSPACE_DATA_DIR=/app/data/workspaces

RUN mkdir -p /var/lib/website-scout-exports /app/data/workspaces \
  && chown -R node:node /app /var/lib/website-scout-exports

USER node

EXPOSE 3000

CMD ["node", "server.js"]

FROM runtime AS test
COPY --chown=node:node tests ./tests
RUN node tests/run-regressions.cjs

FROM runtime AS production
