#!/usr/bin/env bash
set -euo pipefail

echo "=== Isolated scheduling-agent service setup ==="

if ! id -u scheduling-agent >/dev/null 2>&1; then
  echo "Creating system user scheduling-agent..."
  sudo useradd --system --user-group --shell /usr/sbin/nologin --home-dir /var/lib/scheduling-agent scheduling-agent
fi

sudo mkdir -p /var/lib/scheduling-agent /etc/scheduling-agent /opt/scheduling-agent/releases /opt/scheduling-agent/shared
sudo chown scheduling-agent:scheduling-agent /var/lib/scheduling-agent
sudo chmod 0750 /var/lib/scheduling-agent
sudo chmod 0700 /etc/scheduling-agent

ENV_FILE="/etc/scheduling-agent/scheduling-agent.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Creating $ENV_FILE..."
  sudo tee "$ENV_FILE" >/dev/null <<'EOF'
NODE_ENV=production
SCHEDULING_PORT=3531
XAI_API_KEY=
XAI_WEBHOOK_SECRET=
EVIDENCE_TOKEN=
OPERATOR_TOKEN=
MAX_CONCURRENT_CALLS=1
ALLOWED_CALLER_NUMBERS=
MAX_CALL_DURATION_MS=600000
CALL_DURATION_WARNING_MS=60000
SCHEDULING_MONTHLY_TARGET_MICRO_USD=25000000
SCHEDULING_FIXED_MONTHLY_MICRO_USD=1000000
SCHEDULING_RESERVE_MARGIN=0.25
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
GOOGLE_CALENDAR_REFRESH_TOKEN=
SCHEDULING_PRIMARY_CALENDAR=
SCHEDULING_CONFLICT_CALENDARS=
SCHEDULING_ALLOW_CALENDAR_WRITES=
PUBLIC_BASE_URL=https://scheduler.stephens.page
EOF
  sudo chmod 0600 "$ENV_FILE"
  sudo chown root:scheduling-agent "$ENV_FILE"
  echo "Populate XAI_API_KEY, XAI_WEBHOOK_SECRET, EVIDENCE_TOKEN, and ALLOWED_CALLER_NUMBERS in $ENV_FILE"
fi

if ! sudo grep -q '^EVIDENCE_TOKEN=' "$ENV_FILE"; then
  token="$(openssl rand -hex 24)"
  echo "EVIDENCE_TOKEN=${token}" | sudo tee -a "$ENV_FILE" >/dev/null
fi

if ! sudo grep -q '^OPERATOR_TOKEN=' "$ENV_FILE"; then
  token="$(openssl rand -hex 24)"
  echo "OPERATOR_TOKEN=${token}" | sudo tee -a "$ENV_FILE" >/dev/null
fi

sudo cp ops/systemd/scheduling-agent.service /etc/systemd/system/scheduling-agent.service
sudo systemctl daemon-reload

if [ -f ops/apache/scheduler.stephens.page.conf ]; then
  sudo cp ops/apache/scheduler.stephens.page.conf /etc/apache2/sites-available/scheduler.stephens.page.conf
  sudo a2ensite scheduler.stephens.page.conf || true
  sudo systemctl reload apache2 || true
fi

echo "=== Setup complete ==="
