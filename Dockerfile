FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ghostscript python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# pikepdf ships prebuilt wheels for this base image's Python/glibc, so this
# doesn't need to compile anything. --break-system-packages: acceptable in a
# single-purpose container image with no other Python workload to conflict
# with (Debian's PEP 668 guard is meant for shared host systems).
RUN pip3 install --no-cache-dir --break-system-packages pikepdf

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
