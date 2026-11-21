# syntax=docker/dockerfile:1

# ---- build stage: install all deps (compiles native bcrypt), transpile src -> dist
FROM node:20-slim AS build
WORKDIR /app
# build tools for native modules (bcrypt)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# package-lock.json is committed: `npm ci` installs exactly the tested versions
# (and fails if package.json and the lock disagree) instead of whatever is newest.
COPY package.json package-lock.json ./
RUN npm ci
COPY .babelrc ./
COPY src ./src
RUN npm run build
# drop dev dependencies but KEEP the already-compiled native modules (bcrypt, pg)
RUN npm prune --omit=dev

# ---- runtime stage: only prod node_modules + dist, no build toolchain
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The SQL migrations: `node dist/scripts/migrate.js` (run from /app) reads db/migrations.
COPY db ./db
# B17: with STORAGE_DRIVER=local, uploaded photos/documents go here (mount a
# volume; owned by the app user). Compose runs MinIO instead (STORAGE_DRIVER=s3).
# sharp (photo resizing) installs a prebuilt linux binary via npm ci: no apt deps.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
ENV UPLOAD_DIR=/app/uploads
EXPOSE 5050
USER node
CMD ["node", "dist/index.js"]
