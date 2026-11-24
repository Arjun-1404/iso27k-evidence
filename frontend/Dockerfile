FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Registry and retries, and why there are no BuildKit-only options: see the backend Dockerfile.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY" \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
COPY . .
# Vite inlines import.meta.env.* at build time, not runtime — the API URL has to be known here,
# not just passed to the running container later.
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# The server settings and the security headers are in frontend/nginx/ (see the comments there).
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
EXPOSE 80
