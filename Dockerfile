# Production image for Pixel Kicks Tracking (Remix + Prisma/Postgres). Used by Railway.
#
# Two stages. The BUILD needs dev dependencies (Vite is a devDependency) but the runtime does not, so the
# builder is discarded and the runtime stage installs production dependencies only. A single-stage build
# shipped Vite, Jest, ESLint and TypeScript to production for no reason.
#
# The runtime stage deliberately runs its own `npm ci --omit=dev` rather than copying node_modules from
# the builder and pruning: pruning relies on `npm prune` leaving the generated Prisma client (which lives
# outside npm's package bookkeeping, in node_modules/.prisma) untouched. A clean install plus an explicit
# `prisma generate` costs a little build time and removes that assumption entirely.
#
# NOTE: `node:22-slim` is a FLOATING tag, so two deploys of the same commit can land on different base
# images. Worth pinning to a digest (`node:22-slim@sha256:...`) once you're ready to own updating it.
FROM node:22-slim AS builder

WORKDIR /app

# Prisma needs openssl on debian-slim.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# All deps (incl. dev) against the committed lockfile, then build the Remix server bundle.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build


FROM node:22-slim AS runtime

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production dependencies only. `prisma` and `@prisma/client` are both runtime deps (the CMD shells out to
# the CLI for `migrate deploy`), so they survive --omit=dev.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Schema + migrations are needed at boot; the built bundle is what we serve.
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=builder /app/build ./build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Apply any pending migrations, then serve. (DATABASE_URL must be set in the Railway service.)
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
