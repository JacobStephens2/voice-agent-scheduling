#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-}"
if [ -z "${SOURCE}" ] || [ ! -d "${SOURCE}" ]; then
  echo "Usage: sudo bash ops/restore-scheduling-state.sh /var/backups/scheduling-agent/<stamp>" >&2
  exit 1
fi

ETC_SRC="${SOURCE}/etc-scheduling-agent"
STATE_SRC="${SOURCE}/var-lib-scheduling-agent"
if [ ! -d "${ETC_SRC}" ] || [ ! -d "${STATE_SRC}" ]; then
  echo "Backup ${SOURCE} is missing etc-scheduling-agent or var-lib-scheduling-agent." >&2
  echo "Admission will stay unavailable until a complete restore is provided." >&2
  exit 1
fi

echo "=== Restoring isolated scheduling state from ${SOURCE} ==="
echo "Calendar appointments are not in this backup and will not be deleted or recreated."

sudo systemctl stop scheduling-agent || true
sudo mkdir -p /etc/scheduling-agent /var/lib/scheduling-agent
sudo cp -a "${ETC_SRC}/." /etc/scheduling-agent/
sudo cp -a "${STATE_SRC}/." /var/lib/scheduling-agent/
sudo chown -R root:scheduling-agent /etc/scheduling-agent
sudo chmod 0700 /etc/scheduling-agent
sudo chmod 0600 /etc/scheduling-agent/scheduling-agent.env || true
sudo chown -R scheduling-agent:scheduling-agent /var/lib/scheduling-agent
sudo chmod 0750 /var/lib/scheduling-agent
sudo systemctl start scheduling-agent
sudo systemctl is-active scheduling-agent

echo "Restore complete. Check GET /health for pauseReason if admission is unavailable."
