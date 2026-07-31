# 军火商 — 容器部署镜像（适用于 Hugging Face Spaces / Koyeb / Render / Fly.io 等）
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Hugging Face Spaces 固定将流量路由到 7860；其他平台以 PORT 环境变量为准（server.js 已支持）
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
