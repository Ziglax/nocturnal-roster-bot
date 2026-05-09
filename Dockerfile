FROM node:18-alpine

WORKDIR /app

# Install dependencies only — source code is bind-mounted at runtime via docker-compose.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

EXPOSE 3000
CMD ["node", "index.js"]
