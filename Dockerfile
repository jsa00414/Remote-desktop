FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=5000
ENV SKIP_LOCAL_HOST=1
ENV ADMIN_PASSWORD=8112026
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 5000

CMD ["node", "server.js"]
