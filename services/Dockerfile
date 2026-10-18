# One image for indexer / api / keeper; SERVICE_ENTRY picks which (e.g. api/dist/main.js).
# §9: base image pinned by digest (node:22-slim, multi-arch index, resolved 2026-10-17; bump deliberately), multi-stage
# build: compilers / test tooling (typescript, vitest, tsx, …) never reach the runtime image (`npm prune --omit=dev`).
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app
COPY --from=build /app /app
RUN chown -R root:root /app && chmod -R a-w /app
ENV NODE_ENV=production
# L-9: run as the image's unprivileged `node` user (the app tree is read-only to it).
USER node
CMD ["sh", "-c", "exec node ${SERVICE_ENTRY:?set SERVICE_ENTRY}"]
