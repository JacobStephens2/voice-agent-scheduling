#!/usr/bin/env bash
set -euo pipefail

_ops_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_backup_durable_helper="${_ops_dir}/backup_durable_files.py"
_durable_state_helper="${_ops_dir}/durable_state.py"

backup_durable_files() {
  local src="$1"
  local dest="$2"
  if [ "$#" -ge 3 ]; then
    PYTHONDONTWRITEBYTECODE=1 python3 "${_backup_durable_helper}" --expected-uid "$3" "${src}" "${dest}"
  else
    PYTHONDONTWRITEBYTECODE=1 python3 "${_backup_durable_helper}" "${src}" "${dest}"
  fi
}

backup_to_dest() {
  local dest="$1"
  local etc_src="$2"
  local state_src="$3"
  local expected_uid_args=()
  if [ "$#" -ge 4 ]; then
    expected_uid_args=("$4")
  fi

  local expected_uid
  expected_uid="$(PYTHONDONTWRITEBYTECODE=1 python3 "${_durable_state_helper}" resolve-uid ${expected_uid_args[@]+"${expected_uid_args[@]}"})"

  if [ -L "${etc_src}" ] || [ ! -d "${etc_src}" ]; then
    echo "Refusing backup: ${etc_src} is not a directory." >&2
    return 1
  fi

  local dest_root
  dest_root="$(dirname "${dest}")"
  if [ -L "${dest_root}" ]; then
    echo "Refusing backup: ${dest_root} is a symlink." >&2
    return 1
  fi
  mkdir -p -m 0700 "${dest_root}"

  (
    mkdir -m 0700 "${dest}" || exit 1
    complete=0
    cleanup_incomplete_backup() {
      if [ "${complete}" -ne 1 ]; then
        rm -rf -- "${dest}"
      fi
    }
    trap cleanup_incomplete_backup EXIT INT TERM

    cp -a "${etc_src}" "${dest}/etc-scheduling-agent" || exit 1
    backup_durable_files "${state_src}" "${dest}/var-lib-scheduling-agent" "${expected_uid}" || exit 1
    complete=1
  )
}

main() {
  local DEST_ROOT="${1:-/var/backups/scheduling-agent}"
  local STAMP
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  local DEST="${DEST_ROOT%/}/${STAMP}"
  local expected_uid
  expected_uid="$(PYTHONDONTWRITEBYTECODE=1 python3 "${_durable_state_helper}" resolve-uid)"

  echo "=== Backing up isolated scheduling state to ${DEST} ==="
  echo "This copy is credentials and durable application state only."
  echo "It does not include Google Calendar events or provider-side logs."

  if [ "$(id -u)" -eq 0 ]; then
    backup_to_dest "${DEST}" /etc/scheduling-agent /var/lib/scheduling-agent "${expected_uid}"
  else
    local script_path
    script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    sudo bash -c 'set -euo pipefail; source "$1"; backup_to_dest "$2" "$3" "$4" "$5"' \
      bash "${script_path}" "${DEST}" /etc/scheduling-agent /var/lib/scheduling-agent "${expected_uid}"
  fi

  echo "Backup written to ${DEST}"
  echo "Restore with: sudo bash ops/restore-scheduling-state.sh ${DEST}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
