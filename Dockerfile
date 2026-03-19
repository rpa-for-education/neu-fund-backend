# ===========================================
# neu-fund-backend — Dockerfile
# ===========================================
# Multi-stage: production (slim) và development (full deps)
# Sử dụng MongoDB Atlas, không có MongoDB local trong Docker
#
# Lưu ý: Dùng Debian (không dùng Alpine) vì onnxruntime-node cần glibc,
# Alpine dùng musl → lỗi ld-linux-aarch64.so.1


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

EXPOSE 8017
CMD ["node", "server.js"]