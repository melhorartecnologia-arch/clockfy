#!/usr/bin/env bash
# Atualiza o Clockfy para a versão mais recente do repositório (sem build: web/dist já vem compilado).
# Uso: sudo /opt/clockfy/deploy/update.sh
set -euo pipefail
APP_DIR=${CLOCKFY_DIR:-/opt/clockfy}
SERVICE_USER=$(stat -c %U "$APP_DIR")
"$APP_DIR/deploy/backup.sh" || echo "[aviso] backup falhou; continuando"
sudo -u "$SERVICE_USER" git -C "$APP_DIR" pull --ff-only
sudo -u "$SERVICE_USER" bash -c "cd '$APP_DIR' && npm ci --omit=dev --workspace=server --no-audit --no-fund --loglevel=error"
systemctl restart clockfy
sleep 3 && curl -fsS http://127.0.0.1:3000/health >/dev/null && echo "Clockfy atualizado e ativo" || { journalctl -u clockfy -n 20 --no-pager; exit 1; }
