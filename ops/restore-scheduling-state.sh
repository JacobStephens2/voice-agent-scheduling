#!/usr/bin/env bash
set -euo pipefail

# Copy a durable-state tree onto dest. The caller creates dest.
# Each restored name is opened relative to its parent directory fd. That open
# fails closed when the final name is a symlink, so the backup is not written
# through the link. Names the backup does not restore stay in place.
_restore_durable_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/restore_durable_tree.py"

restore_durable_tree() {
  local src="$1"
  local dest="$2"
  if [ -L "${dest}" ]; then
    echo "Refusing restore: ${dest} is a symlink." >&2
    return 1
  fi
  PYTHONDONTWRITEBYTECODE=1 python3 "${_restore_durable_helper}" "${src}" "${dest}"
}

main() {
  local SOURCE="${1:-}"
  if [ -z "${SOURCE}" ] || [ ! -d "${SOURCE}" ]; then
    echo "Usage: sudo bash ops/restore-scheduling-state.sh /var/backups/scheduling-agent/<stamp>" >&2
    exit 1
  fi

  local ETC_SRC="${SOURCE}/etc-scheduling-agent"
  local STATE_SRC="${SOURCE}/var-lib-scheduling-agent"
  if [ ! -d "${ETC_SRC}" ] || [ ! -d "${STATE_SRC}" ]; then
    echo "Backup ${SOURCE} is missing etc-scheduling-agent or var-lib-scheduling-agent." >&2
    echo "Admission will stay unavailable until a complete restore is provided." >&2
    exit 1
  fi

  # Refuse before stopping the service or copying credentials. mkdir -p would
  # leave this symlink in place, and the state copy would not run.
  if [ -L /var/lib/scheduling-agent ]; then
    echo "Refusing restore: /var/lib/scheduling-agent is a symlink." >&2
    exit 1
  fi

  echo "=== Restoring isolated scheduling state from ${SOURCE} ==="
  echo "Calendar appointments are not in this backup and will not be deleted or recreated."

  sudo systemctl stop scheduling-agent || true
  sudo mkdir -p /etc/scheduling-agent /var/lib/scheduling-agent
  sudo cp -a "${ETC_SRC}/." /etc/scheduling-agent/
  local script_path
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  sudo bash -c 'set -euo pipefail; source "$1"; restore_durable_tree "$2" "$3"' bash "${script_path}" "${STATE_SRC}" /var/lib/scheduling-agent
  sudo chown -R root:scheduling-agent /etc/scheduling-agent
  sudo chmod 0700 /etc/scheduling-agent
  sudo chmod 0600 /etc/scheduling-agent/scheduling-agent.env || true
  sudo chown -R scheduling-agent:scheduling-agent /var/lib/scheduling-agent
  sudo chmod 0750 /var/lib/scheduling-agent
  sudo systemctl start scheduling-agent
  sudo systemctl is-active scheduling-agent

  echo "Restore complete. Check GET /health for pauseReason if admission is unavailable."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
