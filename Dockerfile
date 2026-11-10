# Voidpost runs on Bun and has no npm dependencies, so the image is just the
# source: nothing to install, no build step.
FROM oven/bun:1-alpine

WORKDIR /app

# Copied explicitly instead of "COPY . ." so that .env, data/ and logs can never
# be baked into the image.
COPY package.json ./
COPY index.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Port 25 for inbound mail, 3000 for the web interface. The image runs as root,
# which is what allows the SMTP listener to bind the privileged port when
# SMTP_PORT=25.
EXPOSE 3000 25

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/login" || exit 1

CMD ["bun", "index.js"]
