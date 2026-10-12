FROM rust:1-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home grinder
COPY --from=build /src/target/release/fumpad-grinder /usr/local/bin/fumpad-grinder
# L-9: never run as root.
USER grinder
CMD ["fumpad-grinder"]
