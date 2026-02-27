# === Base image: Debian + glibc (BẮT BUỘC cho AI / ONNX) ===
FROM node:20-bookworm-slim

# === Set working directory ===
WORKDIR /app

# === Copy package files trước để cache dependency ===
COPY package*.json ./

# === Install Node dependencies ===
RUN npm ci

# === Copy toàn bộ source code ===
COPY . .

# === Expose API port (đổi nếu server.js listen khác 4000) ===
EXPOSE 4000

# === Run AI / API server ===
CMD ["node", "server.js"]