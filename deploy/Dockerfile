# Programos surinkimas ir nginx su NodeODM tarpininku
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Programos versija (start-windows.bat: git data ir žymė) – rodoma Pagalboje
ARG APP_VERSION=
ENV APP_VERSION=$APP_VERSION
RUN npm run build

FROM nginx:1.27-alpine
# Šablonas – nginx paleidimo metu įrašo NODEODM_TOKEN
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
