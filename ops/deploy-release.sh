#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${SCHEDULER_HOST:-jacob@stephens.page}"
RELEASE_ID="${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
REMOTE_RELEASE="/opt/scheduling-agent/releases/${RELEASE_ID}"

cd "$ROOT"
npm run typecheck
npm test
npm run build

ssh "$HOST" "sudo mkdir -p '${REMOTE_RELEASE}/dist' && sudo chown -R jacob:jacob '${REMOTE_RELEASE}'"
rsync -a --delete "${ROOT}/dist/" "$HOST:${REMOTE_RELEASE}/dist/"
scp "${ROOT}/package.json" "${ROOT}/package-lock.json" "$HOST:${REMOTE_RELEASE}/"
scp "${ROOT}/ops/systemd/scheduling-agent.service" "$HOST:/tmp/scheduling-agent.service"

ssh "$HOST" bash -s <<EOF
set -euo pipefail
cd '${REMOTE_RELEASE}'
npm ci --omit=dev
sudo chown -R scheduling-agent:scheduling-agent '${REMOTE_RELEASE}'
sudo cp /tmp/scheduling-agent.service /etc/systemd/system/scheduling-agent.service
sudo ln -sfn '${REMOTE_RELEASE}' /opt/scheduling-agent/current
sudo systemctl daemon-reload
sudo systemctl restart scheduling-agent
sudo systemctl is-active scheduling-agent
for i in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:3531/health; then
    echo
    break
  fi
  sleep 1
done
EOF

echo "Deployed ${RELEASE_ID}"
