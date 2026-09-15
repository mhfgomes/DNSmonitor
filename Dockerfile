FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY tests ./tests
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ARG VCS_REF=unknown
ARG SOURCE_URL
ENV NODE_ENV=production BUILD_REVISION=$VCS_REF
LABEL org.opencontainers.image.title="DNSmonitor" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.source=$SOURCE_URL
WORKDIR /app
COPY --from=build /app/package.json ./
COPY LICENSE ./LICENSE
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/apps ./dist/apps
COPY --from=build /app/dist/packages ./dist/packages
COPY --from=build /app/dist/web ./dist/web
COPY examples ./examples
USER node
EXPOSE 3000 3001
CMD ["node", "dist/apps/api/src/main.js"]
