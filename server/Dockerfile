FROM node:22-alpine AS build
RUN npm install -g npm@11.21.2
WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
RUN npm install --workspaces --include-workspace-root

COPY server ./server
RUN npm run build -w server

FROM node:22-alpine AS runtime
RUN npm install -g npm@11.21.2
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
RUN npm install --workspaces --include-workspace-root --omit=dev

COPY --from=build /app/server/dist ./server/dist

EXPOSE 3000
USER node
CMD ["node", "server/dist/index.js"]
