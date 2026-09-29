#!/usr/bin/env bash
# Atualiza o Clockfy para a versão mais recente do repositório (Docker ou manual).
set -euo pipefail
cd "${CLOCKFY_DIR:-/opt/clockfy}"
git pull --ff-only
if [ -f docker-compose.yml ] && docker compose ps >/dev/null 2>&1 && [ "${MODE:-docker}" = "docker" ]; then
  docker compose up -d --build
  docker image prune -f
else
  npm install
  npm run build
  systemctl restart clockfy
fi
echo "Clockfy atualizado"
