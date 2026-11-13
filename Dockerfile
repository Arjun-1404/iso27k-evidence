FROM node:25-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Where the libraries are downloaded from. Leave it alone unless your network blocks registry.npmjs.org; then set
# NPM_REGISTRY in .env to a mirror. npm still checks every download against the hashes in package-lock.json.
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Retries and a persistent download cache: a flaky network (VPN, proxy, Docker Desktop DNS) otherwise makes npm give
# up with "Exit handler never called". With the cache, a second attempt only fetches what is still missing.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

FROM node:25-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY db ./db

# The app runs its TypeScript directly with tsx, which is therefore a normal (not dev-only) dependency
# and is already in node_modules from the stage above.

EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
