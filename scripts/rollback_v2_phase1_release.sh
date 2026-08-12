#!/usr/bin/env bash
# Restore an exact V2 backup produced by install_v2_phase1_release.sh.
set -Eeuo pipefail

if [[ ${EUID} -ne 0 || $# -ne 1 ]]; then
  echo "usage: sudo $0 <absolute-backup-directory>" >&2
  exit 2
fi
ROOT=/home/exedev/songs-v2
BACKUP_DIR=$(realpath "$1")
UNIT=/etc/systemd/system/songs-v2-api.service
case "${BACKUP_DIR}" in
  "${ROOT}/var/releases/backups/"*) ;;
  *) echo "backup must be below ${ROOT}/var/releases/backups" >&2; exit 2 ;;
esac
[[ -f ${BACKUP_DIR}/SHA256SUMS && -f ${BACKUP_DIR}/READY ]]
(
  cd "${BACKUP_DIR}"
  sha256sum -c SHA256SUMS
)

if [[ -f ${BACKUP_DIR}/FIRST_INSTALL ]]; then
  systemctl disable --now songs-v2-api.service
  rm -f "${UNIT}"
  systemctl daemon-reload
  ! systemctl is-active --quiet songs-v2-api.service
else
  [[ -f ${BACKUP_DIR}/songs-v2-api && -f ${BACKUP_DIR}/songs-v2-api.service && -f ${BACKUP_DIR}/previous-binary-path && -f ${BACKUP_DIR}/previous-binary-sha256 ]]
  PREVIOUS_EXEC=$(cat "${BACKUP_DIR}/previous-binary-path")
  [[ ${PREVIOUS_EXEC} = /* ]]
  install -d -m 0755 "$(dirname "${PREVIOUS_EXEC}")"
  install -m 0755 "${BACKUP_DIR}/songs-v2-api" "${PREVIOUS_EXEC}.restore"
  mv "${PREVIOUS_EXEC}.restore" "${PREVIOUS_EXEC}"
  install -m 0644 "${BACKUP_DIR}/songs-v2-api.service" "${UNIT}.restore"
  mv "${UNIT}.restore" "${UNIT}"
  systemctl daemon-reload
  if grep -qx enabled "${BACKUP_DIR}/previous-enabled"; then
    systemctl enable songs-v2-api.service
  else
    systemctl disable songs-v2-api.service
  fi
  if grep -qx active "${BACKUP_DIR}/previous-active"; then
    systemctl restart songs-v2-api.service
    systemctl is-active --quiet songs-v2-api.service
    [[ $(systemctl show -p ExecStart --value songs-v2-api.service) == *"${PREVIOUS_EXEC}"* ]]
    EXPECTED_SHA=$(cat "${BACKUP_DIR}/previous-binary-sha256")
    echo "${EXPECTED_SHA}  ${PREVIOUS_EXEC}" | sha256sum -c -
    ROOT_STATUS=000
    for _ in $(seq 1 30); do
      ROOT_STATUS=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
        -H 'X-ExeDev-UserID: rollback-local' \
        -H 'X-Forwarded-Proto: https' \
        -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8001' \
        http://127.0.0.1:8001/ 2>/dev/null || true)
      [[ ${ROOT_STATUS} == 200 ]] && break
      sleep 1
    done
    [[ ${ROOT_STATUS} == 200 ]]
    curl -fsS --max-time 10 \
      -H 'X-ExeDev-UserID: rollback-local' \
      -H 'X-Forwarded-Proto: https' \
      -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8001' \
      http://127.0.0.1:8001/api/v2/bootstrap/manifest >/dev/null
  else
    systemctl stop songs-v2-api.service
    ! systemctl is-active --quiet songs-v2-api.service
  fi
fi
systemctl is-active --quiet songs.service
curl -fsS --max-time 10 http://127.0.0.1:8000/ >/dev/null
printf 'restored %s\n' "${BACKUP_DIR}"
