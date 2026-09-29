#!/usr/bin/env bash
# =============================================================================
#  Clockfy – instalador para Ubuntu Server 24.04 LTS (sem Docker, sem build)
#
#  Instala Node.js 22, PostgreSQL 16, Nginx, cria o banco, o usuário de serviço,
#  clona o repositório (a interface já vem compilada em web/dist), gera o .env,
#  registra o serviço systemd e, se DOMAIN for informado, configura o Nginx e o
#  certificado HTTPS (Let's Encrypt). Pode ser executado várias vezes (idempotente).
#
#  Uso (como root ou com sudo):
#    sudo DOMAIN=clockfy.suaempresa.com.br LETSENCRYPT_EMAIL=voce@suaempresa.com.br \
#         bash deploy/install-ubuntu.sh
#
#  Variáveis opcionais:
#    REPO_URL   (padrão: https://github.com/melhorartecnologia-arch/clockfy.git)
#    BRANCH     (padrão: main; use claude/zen-curie-y7y4bq até a integração)
#    APP_DIR    (padrão: /opt/clockfy)
#    DB_PASSWORD (padrão: gerada automaticamente e gravada no .env)
#    SKIP_NGINX=1  não configura o Nginx    SKIP_SSL=1  não emite certificado
# =============================================================================
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/melhorartecnologia-arch/clockfy.git}
BRANCH=${BRANCH:-main}
APP_DIR=${APP_DIR:-/opt/clockfy}
DOMAIN=${DOMAIN:-}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:-}
DB_NAME=${DB_NAME:-clockfy}
DB_USER=${DB_USER:-clockfy}
DB_PASSWORD=${DB_PASSWORD:-}
SERVICE_USER=clockfy
PORT=${PORT:-3000}
SKIP_NGINX=${SKIP_NGINX:-0}
SKIP_SSL=${SKIP_SSL:-0}

log()  { echo -e "\033[1;34m[clockfy]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[ok]\033[0m $*"; }
fail() { echo -e "\033[1;31m[erro]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "execute como root: sudo bash deploy/install-ubuntu.sh"
grep -qi ubuntu /etc/os-release || fail "este instalador foi feito para Ubuntu (24.04 LTS)"
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- 1. pacotes
log "Atualizando pacotes do sistema"
apt-get update -qq || echo "[aviso] apt-get update terminou com avisos"
apt-get install -y -qq curl git ca-certificates gnupg ufw fail2ban unattended-upgrades openssl cron sudo >/dev/null
ok "pacotes básicos"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  log "Instalando Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN=$(command -v node); NPM_BIN=$(command -v npm)
ok "Node.js $($NODE_BIN -v) / npm $($NPM_BIN -v) ($NODE_BIN)"
# executa comandos como o usuário de serviço mantendo PATH e proxy (se houver)
as_service() { sudo -u "$SERVICE_USER" env PATH="$PATH" HOME="$APP_DIR" ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} bash -c "$1"; }

if ! command -v psql >/dev/null 2>&1; then
  log "Instalando PostgreSQL"
  apt-get install -y -qq postgresql postgresql-contrib >/dev/null
fi
systemctl enable --now postgresql >/dev/null 2>&1 || true
ok "PostgreSQL $(psql --version | awk '{print $3}')"

# ------------------------------------------------------ 2. usuário e código
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  adduser --system --group --home "$APP_DIR" --shell /bin/bash "$SERVICE_USER" >/dev/null
fi
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  log "Atualizando código em $APP_DIR (branch $BRANCH)"
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" checkout --quiet "$BRANCH"
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" pull --quiet --ff-only origin "$BRANCH"
else
  log "Clonando $REPO_URL (branch $BRANCH) em $APP_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
  sudo -u "$SERVICE_USER" git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
[ -f "$APP_DIR/web/dist/index.html" ] || fail "web/dist não encontrado no repositório – a interface precisa estar compilada (npm run build) e versionada"
ok "código pronto"

log "Instalando dependências de produção (somente servidor)"
as_service "cd '$APP_DIR' && '$NPM_BIN' ci --omit=dev --workspace=server --no-audit --no-fund --loglevel=error" || true
[ -d "$APP_DIR/node_modules/pg" ] && [ -d "$APP_DIR/node_modules/express" ] || fail "npm ci não instalou as dependências (veja $APP_DIR/.npm/_logs); verifique o acesso à internet e tente de novo"
ok "dependências instaladas"

# ------------------------------------------------------------- 3. banco
ENV_FILE="$APP_DIR/server/.env"
if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  DB_PASSWORD=$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#^DATABASE_URL=postgres://[^:]+:([^@]+)@.*#\1#')
fi
[ -n "$DB_PASSWORD" ] || DB_PASSWORD=$(openssl rand -hex 16)
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  sudo -u postgres psql -qc "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
else
  sudo -u postgres psql -qc "ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres psql -qc "CREATE DATABASE $DB_NAME OWNER $DB_USER ENCODING 'UTF8';"
fi
ok "banco $DB_NAME (usuário $DB_USER)"

# --------------------------------------------------------------- 4. .env
if [ ! -f "$ENV_FILE" ]; then
  log "Gerando $ENV_FILE"
  APP_URL_VALUE="http://$(hostname -I | awk '{print $1}'):$PORT"
  [ -n "$DOMAIN" ] && APP_URL_VALUE="http://$DOMAIN"
  cat > "$ENV_FILE" <<ENV
PORT=$PORT
NODE_ENV=production
DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
JWT_SECRET=$(openssl rand -hex 32)
APP_URL=$APP_URL_VALUE
# E-mail (opcional): sem SMTP os e-mails são apenas registrados no log
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="Clockfy <no-reply@${DOMAIN:-localhost}>"
RATE_LIMIT_PER_SECOND=50
SCHEDULER_ENABLED=true
MAX_UPLOAD_BYTES=10485760
ENV
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  ok ".env criado"
else
  ok ".env existente mantido"
fi

log "Aplicando migrações do banco"
as_service "cd '$APP_DIR/server' && '$NODE_BIN' src/cli/migrate.js" | tail -1

# ------------------------------------------------------------ 5. systemd
install -m 644 "$APP_DIR/deploy/clockfy.service" /etc/systemd/system/clockfy.service
sed -i -e "s#/opt/clockfy#$APP_DIR#g" -e "s#ExecStart=/usr/bin/node#ExecStart=$NODE_BIN#" /etc/systemd/system/clockfy.service
systemctl daemon-reload
systemctl enable clockfy >/dev/null 2>&1
systemctl restart clockfy
sleep 3
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then ok "serviço clockfy ativo na porta $PORT"; else journalctl -u clockfy -n 30 --no-pager; fail "o serviço não respondeu em /health"; fi

# -------------------------------------------------------------- 6. nginx
if [ "$SKIP_NGINX" != "1" ]; then
  apt-get install -y -qq nginx >/dev/null
  SERVER_NAME=${DOMAIN:-_}
  sed -e "s/clockfy.exemplo.com.br/$SERVER_NAME/" -e "s#127.0.0.1:3000#127.0.0.1:$PORT#" "$APP_DIR/deploy/nginx-clockfy.conf" > /etc/nginx/sites-available/clockfy
  ln -sf /etc/nginx/sites-available/clockfy /etc/nginx/sites-enabled/clockfy
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null && systemctl enable --now nginx >/dev/null 2>&1 && systemctl reload nginx
  ok "nginx configurado (server_name $SERVER_NAME)"
  if [ -n "$DOMAIN" ] && [ "$SKIP_SSL" != "1" ]; then
    log "Emitindo certificado HTTPS para $DOMAIN"
    if ! command -v certbot >/dev/null 2>&1; then snap install core >/dev/null 2>&1 || true; snap install --classic certbot >/dev/null; ln -sf /snap/bin/certbot /usr/bin/certbot; fi
    if certbot --nginx -d "$DOMAIN" --redirect -n --agree-tos ${LETSENCRYPT_EMAIL:+-m "$LETSENCRYPT_EMAIL"} ${LETSENCRYPT_EMAIL:---register-unsafely-without-email}; then
      sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" "$ENV_FILE"; systemctl restart clockfy
      ok "HTTPS ativo em https://$DOMAIN"
    else
      echo "[aviso] certbot falhou (DNS ainda não aponta para este servidor?). Repita depois: certbot --nginx -d $DOMAIN --redirect"
    fi
  fi
fi

# ------------------------------------------------------------ 7. firewall
if ufw allow OpenSSH >/dev/null 2>&1 && ufw allow 80/tcp >/dev/null 2>&1 && ufw allow 443/tcp >/dev/null 2>&1 && ufw --force enable >/dev/null 2>&1; then
  ok "firewall ufw ativo (22, 80, 443)"
else
  echo "[aviso] não foi possível ativar o ufw; garanta o firewall pelo security group da AWS"
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# ------------------------------------------------------------- 8. backup
mkdir -p /var/backups/clockfy
( crontab -l 2>/dev/null | grep -v 'deploy/backup.sh' || true; echo "0 3 * * * $APP_DIR/deploy/backup.sh >> /var/log/clockfy-backup.log 2>&1" ) | crontab -
ok "backup diário agendado (03:00) em /var/backups/clockfy"

echo
echo "=================================================================="
echo " Clockfy instalado!"
echo "   Endereço : $(grep '^APP_URL=' "$ENV_FILE" | cut -d= -f2-)"
echo "   Código   : $APP_DIR      .env: $ENV_FILE"
echo "   Serviço  : systemctl status clockfy   logs: journalctl -u clockfy -f"
echo "   Atualizar: sudo $APP_DIR/deploy/update.sh"
echo " Abra o endereço no navegador e clique em 'Criar conta' (o primeiro usuário vira administrador)."
echo "=================================================================="
