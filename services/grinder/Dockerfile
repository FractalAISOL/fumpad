# §9: base images pinned by digest (multi-arch indexes, resolved 2026-10-17; bump deliberately) and `--locked`: the
# build uses exactly Cargo.lock (fails instead of silently re-resolving).
FROM rust:1-slim@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
# ca-certificates: the system trust store (S-10: DATABASE_SSL=verify-full checks the Postgres server certificate)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home grinder
COPY --from=build /src/target/release/fumpad-grinder /usr/local/bin/fumpad-grinder
# L-9: never run as root.
USER grinder
CMD ["fumpad-grinder"]
