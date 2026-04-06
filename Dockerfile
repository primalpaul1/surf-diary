FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=optional
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
