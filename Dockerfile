# 恒易记账同步后端 —— 多阶段构建
# 阶段1：安装依赖 + 编译 TS（better-sqlite3 是原生模块，需要构建工具链）
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 换国内 apt 源（bookworm），避免默认 Debian 源在服务器出网被干扰拉不到包
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null \
    || true

# 原生模块 better-sqlite3 编译所需
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 阶段2：运行时镜像（尽量小）
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 只带运行所需
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# 数据目录（SQLite 文件），用卷持久化
RUN mkdir -p /app/data
ENV EVEREASY_DB=/app/data/evereasy.db
ENV PORT=8787

EXPOSE 8787
CMD ["node", "dist/index.js"]
