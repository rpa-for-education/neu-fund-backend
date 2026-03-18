FROM node:20-bookworm-slim

# === CÀI SYSTEM DEPENDENCIES CHO SHARP ===
RUN apt-get update && apt-get install -y \
    libvips-dev \
    build-essential \
    python3 \
    pkg-config \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# === ÉP SHARP BUILD FROM SOURCE, KHÔNG DOWNLOAD BINARY ===
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1
ENV npm_config_build_from_source=true

RUN npm ci

COPY . .

EXPOSE 8013
CMD ["node", "server.js"]