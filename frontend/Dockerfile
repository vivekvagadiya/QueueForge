# Builds the dashboard and serves it with nginx, which also proxies /api and
# /socket.io to the API container, so the browser sees a single origin.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Baked in at build time (Vite). /api/v1 = same origin, through the nginx proxy.
ARG VITE_API_BASE_URL=/api/v1
# Only used by the Vite dev server, but vite.config.js requires it to be set.
ARG VITE_API_PROXY_TARGET=http://api:4000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_API_PROXY_TARGET=$VITE_API_PROXY_TARGET
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
