FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production AUTH_DIR=/app/auth
CMD ["npx", "tsx", "src/index.ts"]
