FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    TMP_DIR=/tmp/gs-jobs

EXPOSE 8080
USER node

CMD ["node", "src/server.js"]
