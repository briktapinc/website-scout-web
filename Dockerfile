FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY server ./server
COPY src ./src
COPY sql ./sql
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV DB_DRIVER=mysql
EXPOSE 3000

CMD ["node", "server.js"]
