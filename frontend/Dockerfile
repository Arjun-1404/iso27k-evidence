FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Registry, retries and download cache: see the backend Dockerfile.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --registry="$NPM_REGISTRY" \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
COPY . .
# Vite inlines import.meta.env.* at build time, not runtime — the API URL has to be known here,
# not just passed to the running container later.
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# A single-page app needs every path to fall back to index.html so client-side routing (react-router)
# works on a hard refresh of e.g. /controls, not just on in-app navigation.
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / {\n    try_files $uri /index.html;\n  }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
