FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/central/package.json ./apps/central/package.json
# A árvore de produção vem do lock do monorepo; o mesmo commit resolve sempre
# as mesmas versões. Dependências opcionais nativas continuam omitidas.
RUN corepack enable && pnpm install --filter drac-central --prod --frozen-lockfile --no-optional

WORKDIR /app/apps/central
COPY apps/central/src ./src
COPY apps/central/public ./public
COPY apps/central/scripts ./scripts

RUN mkdir -p /app/apps/central/data && chown -R node:node /app/apps/central
USER node

EXPOSE 9765
CMD ["node", "src/server.js"]
