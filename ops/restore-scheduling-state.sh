#!/usr/bin/env bash
set -euo pipefail

# Copy known top-level durable-state files onto dest. The caller creates dest.
# Each source and target name is opened relative to its directory fd with
# O_NOFOLLOW, verifying each source entry is a known regular file owned by the
# expected scheduling-agent UID. Names the backup does not restore stay in place.
_ops_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_restore_durable_helper="${_ops_dir}/restore_durable_tree.py"
_durable_state_helper="${_ops_dir}/durable_state.py"

restore_durable_tree() {
  local src="$1"
  local dest="$2"
  if [ "$#" -ge 3 ]; then
    PYTHONDONTWRITEBYTECODE=1 python3 "${_restore_durable_helper}" --expected-uid "$3" "${src}" "${dest}"
  else
    PYTHONDONTWRITEBYTECODE=1 python3 "${_restore_durable_helper}" "${src}" "${dest}"
  fi
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
  if [ -L "${STATE_SRC}" ]; then
    echo "Refusing restore: ${STATE_SRC} is a symlink." >&2
    exit 1
  fi
  if [ -L /var/lib/scheduling-agent ]; then
    echo "Refusing restore: /var/lib/scheduling-agent is a symlink." >&2
    exit 1
  fi

  local expected_uid
  expected_uid="$(PYTHONDONTWRITEBYTECODE=1 python3 "${_durable_state_helper}" resolve-uid)"

  echo "=== Restoring isolated scheduling state from ${SOURCE} ==="
  echo "Calendar appointments are not in this backup and will not be deleted or recreated."

  sudo systemctl stop scheduling-agent || true
  sudo mkdir -p /etc/scheduling-agent /var/lib/scheduling-agent
  sudo cp -a "${ETC_SRC}/." /etc/scheduling-agent/
  local script_path
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  sudo bash -c 'set -euo pipefail; source "$1"; restore_durable_tree "$2" "$3" "$4"' bash "${script_path}" "${STATE_SRC}" /var/lib/scheduling-agent "${expected_uid}"
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
