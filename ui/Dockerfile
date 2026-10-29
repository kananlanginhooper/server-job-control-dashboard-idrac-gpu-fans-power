# sjc-ui: Angular build served by nginx, which forwards /api and /healthz to the backend
FROM node:20.19-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx ng build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist/sjc-ui/browser /usr/share/nginx/html
