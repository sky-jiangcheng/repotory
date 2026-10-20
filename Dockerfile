# Repotory headless server — single-container build (ADR-0025 Docker tier).
# The desktop app stays out of Docker; this image is for NAS/homelab users who
# want `repotory-server` (same-origin web UI) on a volume they can back up.

# --- web dist (server build: base /, output web/dist-server) -----------------
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build:server

# --- server binary (zero CGO, matches the repo's pure-Go SQLite) -------------
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/repotory-server ./cmd/server

# --- runtime ------------------------------------------------------------------
FROM alpine:3.20
RUN adduser -D -H -u 1000 repotory
COPY --from=build /out/repotory-server /usr/local/bin/repotory-server
COPY --from=web /src/web/dist-server /app/web-dist

# os.UserConfigDir() follows XDG_CONFIG_HOME on Linux, so the whole data
# directory — repotory.db, WAL sidecars and backups/ — lives inside the volume.
ENV XDG_CONFIG_HOME=/data \
    REPOTORY_WEB_DIST=/app/web-dist
VOLUME ["/data"]
EXPOSE 18765
USER repotory
ENTRYPOINT ["repotory-server"]
CMD ["--port", "18765", "--web-dist", "/app/web-dist"]
