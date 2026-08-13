FROM node:20-alpine
WORKDIR /app
COPY server.js users.json ./
COPY public ./public
EXPOSE 5050
CMD ["node", "server.js"]
