# 恒易记账同步后端 —— 多阶段构建
# 阶段1：安装依赖 + 编译 TS（better-sqlite3 是原生模块，需要构建工具链）
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 原生模块 better-sqlite3 编译所需
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

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
