# Reproduzierbare Messumgebung für se-eval.
# Gleiches Image für beide Teams: Node-, Git- und Werkzeugversionen sind damit festgelegt.
FROM node:22.22.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/se-eval
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY configs ./configs
COPY templates ./templates
COPY eval.config.example.json ./
RUN npm run build && npm prune --omit=dev

# Arbeitsverzeichnis mit eval.config.json, data/ und results/ wird hier eingebunden
WORKDIR /eval
# Git verweigert sonst Repos, deren Besitzer nicht der Container-Benutzer ist
RUN git config --global --add safe.directory '*'
ENTRYPOINT ["node", "/opt/se-eval/dist/cli.js"]
CMD ["--help"]
