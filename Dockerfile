FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/data /app/certs

ENV PORT=5000
ENV SKIP_LOCAL_HOST=1
ENV ADMIN_PASSWORD=8112026
ENV DATA_DIR=/app/data
ENV ENABLE_HTTPS=1

EXPOSE 5000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
