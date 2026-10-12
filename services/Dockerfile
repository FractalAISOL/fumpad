# One image for indexer / api / keeper; SERVICE_ENTRY picks which (e.g. api/dist/main.js).
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build && chown -R root:root /app && chmod -R a-w /app
ENV NODE_ENV=production
# L-9: run as the image's unprivileged `node` user (the app tree is read-only to it).
USER node
CMD ["sh", "-c", "exec node ${SERVICE_ENTRY:?set SERVICE_ENTRY}"]
