# One image for indexer / api / keeper; SERVICE_ENTRY picks which (e.g. api/dist/main.js).
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build
ENV NODE_ENV=production
CMD ["sh", "-c", "exec node ${SERVICE_ENTRY:?set SERVICE_ENTRY}"]
