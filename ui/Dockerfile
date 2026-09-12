FROM node:22.23.2-alpine3.23 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN NOYARNPOSTINSTALL=1 npm ci

COPY . ./
RUN npm run type-gen && npm run build

FROM nginxinc/nginx-unprivileged:1.31-alpine3.24

COPY --chown=101:101 --from=build /app/dist /usr/share/nginx/html
COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf

USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
