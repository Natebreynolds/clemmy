ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# Deliberately copy one runtime file, never the repository or TLS material.
COPY --chown=node:node server.mjs ./server.mjs

USER node
EXPOSE 9400 8080
STOPSIGNAL SIGTERM

# Node receives the platform's shutdown signal directly as PID 1.
CMD ["node", "server.mjs"]
