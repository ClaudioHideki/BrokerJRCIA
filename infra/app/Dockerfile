FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

COPY tsconfig.json tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/providers/tsconfig.json packages/providers/tsconfig.json
COPY packages/providers/src packages/providers/src
COPY packages/security/tsconfig.json packages/security/tsconfig.json
COPY packages/security/src packages/security/src
COPY packages/ui/tsconfig.json packages/ui/tsconfig.json
COPY packages/ui/src packages/ui/src
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node --from=build /app/packages/providers/package.json ./packages/providers/package.json
COPY --chown=node:node --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --chown=node:node --from=build /app/packages/security/package.json ./packages/security/package.json
COPY --chown=node:node --from=build /app/packages/security/dist ./packages/security/dist
COPY --chown=node:node --from=build /app/packages/security/node_modules ./packages/security/node_modules
COPY --chown=node:node apps/api/drizzle ./apps/api/drizzle
COPY --chown=node:node infra/app/postgres ./infra/app/postgres
COPY --chown=node:node infra/app/provision.mjs ./infra/app/provision.mjs

USER node
EXPOSE 3000
ENTRYPOINT ["node", "apps/api/dist/server.js"]

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/apps/web/dist ./public
COPY --chown=node:node infra/web/server.mjs ./server.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "server.mjs"]

FROM runtime AS default
