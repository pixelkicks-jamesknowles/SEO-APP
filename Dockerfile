# Production image for Pixel Kicks Tracking (Remix + Prisma/Postgres). Used by Railway.
# Build needs dev deps (vite is a devDependency), so we DON'T set NODE_ENV=production until after
# the build. Prisma client + engines are generated at build time (baked in); migrations run on boot.
FROM node:22-slim

WORKDIR /app

# Prisma needs openssl on debian-slim.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install all deps (incl. dev) against the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# App source, then generate the Prisma client and build the Remix server bundle.
COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Apply any pending migrations, then serve. (DATABASE_URL must be set in the Railway service.)
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
