FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json eslint.config.mjs ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
RUN npm run build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src

RUN mkdir --parents /data && chown node:node /data

VOLUME ["/data"]
USER node

ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["stdio", "--workspace", "/data"]
