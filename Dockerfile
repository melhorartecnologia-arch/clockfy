# ---- build da SPA -----------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --workspaces --include-workspace-root
COPY web web
RUN npm run build --workspace=web

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force
COPY server server
COPY --from=web /app/web/dist web/dist
RUN mkdir -p uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server/src/index.js"]
