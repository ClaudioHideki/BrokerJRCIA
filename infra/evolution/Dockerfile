FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS system

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates tzdata && rm -rf /var/lib/apt/lists/*

FROM system AS build
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /evolution
ENV HUSKY=0 PRISMA_SKIP_POSTINSTALL_GENERATE=true CHECKPOINT_DISABLE=1 NODE_OPTIONS=--max-old-space-size=1536
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# generate only; no network database, deploy, migrations, seeds or provider helper.
RUN --network=none DATABASE_CONNECTION_URI=postgresql://jrc_build:jrc_build@127.0.0.1:1/jrc_build ./node_modules/.bin/prisma generate --schema ./prisma/postgresql-schema.prisma
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund --no-save
RUN node jrc-image/record-build.mjs

FROM system AS runtime
WORKDIR /evolution
ENV NODE_ENV=production DOCKER_ENV=true TZ=America/Sao_Paulo DATABASE_PROVIDER=postgresql JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=false
LABEL org.opencontainers.image.title="JRC Evolution engine laboratory candidate" \
      org.opencontainers.image.source="https://github.com/ClaudioHideki/BrokerJRCIA" \
      com.jrc.delivery-ownership="UNPROVEN" \
      com.jrc.evolution-source="fa09d37892cdbb1d65a250155d293d92230c5b30"
COPY --from=build /evolution/package.json /evolution/package-lock.json /evolution/LICENSE /evolution/NOTICE /evolution/TRADEMARKS.md ./
COPY --from=build /evolution/node_modules ./node_modules
COPY --from=build /evolution/dist ./dist
COPY --from=build /evolution/prisma ./prisma
COPY --from=build /evolution/public ./public
COPY --from=build /evolution/manager ./manager
COPY --from=build /evolution/jrc-origin ./jrc-origin
COPY --from=build /evolution/schema ./schema
COPY --from=build /evolution/jrc-image ./jrc-image
COPY --from=build /evolution/jrc-origin-provenance.json /evolution/jrc-engine-build.json ./
RUN mkdir -p store instances temp && chown node:node /evolution store instances temp
USER node
EXPOSE 8080
ENTRYPOINT ["node", "jrc-image/entrypoint.mjs"]
