#!/usr/bin/env bash
set -euo pipefail

DEST_ROOT="${1:-/var/backups/scheduling-agent}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${DEST_ROOT}/${STAMP}"

echo "=== Backing up isolated scheduling state to ${DEST} ==="
echo "This copy is credentials and durable application state only."
echo "It does not include Google Calendar events or provider-side logs."

sudo mkdir -p "${DEST}"
sudo cp -a /etc/scheduling-agent "${DEST}/etc-scheduling-agent"
sudo cp -a /var/lib/scheduling-agent "${DEST}/var-lib-scheduling-agent"
sudo chmod 0700 "${DEST}"

echo "Backup written to ${DEST}"
echo "Restore with: sudo bash ops/restore-scheduling-state.sh ${DEST}"
