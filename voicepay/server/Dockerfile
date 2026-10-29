# VoicePay server image (Render, Railway, Fly.io, any Docker host).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=4000 DATA_FILE=/data/db.json
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
