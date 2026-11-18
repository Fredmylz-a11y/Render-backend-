FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY api ./api
COPY server.js ./server.js
EXPOSE 3000
CMD ["node", "server.js"]
