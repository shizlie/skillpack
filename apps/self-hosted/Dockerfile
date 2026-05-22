# Build stage — compile to single binary with Bun
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/ packages/
COPY apps/api/migrations/ apps/api/migrations/
COPY apps/self-hosted/ apps/self-hosted/
RUN bun install --frozen-lockfile
RUN bun build apps/self-hosted/src/cli.js --compile --outfile skillpack-server

# Runtime stage — distroless base for minimal attack surface
# Bun --compile produces a standalone binary with the runtime embedded.
FROM gcr.io/distroless/base-debian12
COPY --from=build /app/skillpack-server /skillpack-server
COPY --from=build /app/apps/api/migrations/ /migrations/
ENV SKILLPACK_MIGRATIONS_DIR=/migrations
EXPOSE 3001
ENTRYPOINT ["/skillpack-server"]
CMD ["--db", "/data/skillpack.db"]
