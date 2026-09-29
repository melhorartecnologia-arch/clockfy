#!/usr/bin/env bash
# Backup diário do banco do Clockfy (Docker ou PostgreSQL local) com retenção e envio opcional ao S3.
# Uso: sudo /opt/clockfy/deploy/backup.sh   (agende no cron: 0 3 * * * /opt/clockfy/deploy/backup.sh)
set -euo pipefail
BACKUP_DIR=${BACKUP_DIR:-/var/backups/clockfy}
KEEP_DAYS=${KEEP_DAYS:-14}
S3_BUCKET=${S3_BUCKET:-}                     # ex.: s3://minha-empresa-backups/clockfy (opcional)
COMPOSE_DIR=${COMPOSE_DIR:-/opt/clockfy}     # onde está o docker-compose.yml
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/clockfy-$STAMP.sql.gz"

if docker compose -f "$COMPOSE_DIR/docker-compose.yml" ps db >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db pg_dump -U clockfy -d clockfy | gzip > "$FILE"
else
  sudo -u postgres pg_dump -d clockfy | gzip > "$FILE"
fi
echo "backup gerado: $FILE ($(du -h "$FILE" | cut -f1))"
find "$BACKUP_DIR" -name 'clockfy-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
if [ -n "$S3_BUCKET" ]; then aws s3 cp "$FILE" "$S3_BUCKET/" && echo "enviado para $S3_BUCKET"; fi
