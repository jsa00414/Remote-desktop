#!/bin/sh
set -e

CERT_DIR="${CERT_DIR:-/app/certs}"
CERT_FILE="${CERT_FILE:-$CERT_DIR/cert.pem}"
KEY_FILE="${KEY_FILE:-$CERT_DIR/key.pem}"

if [ "${ENABLE_HTTPS:-1}" = "1" ]; then
  mkdir -p "$CERT_DIR"
  if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    echo "Generating self-signed TLS certificate for screen capture (HTTPS)…"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$KEY_FILE" \
      -out "$CERT_FILE" \
      -days 825 \
      -subj "/CN=remote-desktop" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:74.208.54.132"
  fi
  export TLS_CERT_FILE="$CERT_FILE"
  export TLS_KEY_FILE="$KEY_FILE"
fi

exec "$@"
