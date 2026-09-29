#!/usr/bin/env bash
# Restaura um backup gerado por backup.sh. Uso: sudo /opt/clockfy/deploy/restore.sh /var/backups/clockfy/clockfy-XXXX.sql.gz
set -euo pipefail
FILE=${1:?informe o arquivo .sql.gz}
COMPOSE_DIR=${COMPOSE_DIR:-/opt/clockfy}
if docker compose -f "$COMPOSE_DIR/docker-compose.yml" ps db >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_DIR/docker-compose.yml" stop app
  docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db psql -U clockfy -d postgres -c "DROP DATABASE IF EXISTS clockfy WITH (FORCE)" -c "CREATE DATABASE clockfy"
  gunzip -c "$FILE" | docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db psql -U clockfy -d clockfy
  docker compose -f "$COMPOSE_DIR/docker-compose.yml" start app
else
  systemctl stop clockfy
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS clockfy WITH (FORCE)" -c "CREATE DATABASE clockfy OWNER clockfy"
  gunzip -c "$FILE" | sudo -u postgres psql -d clockfy
  systemctl start clockfy
fi
echo "restaurado a partir de $FILE"
