#!/usr/bin/env bash
# Install one reviewed, content-addressed read-only V2 release and fail closed.
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root: sudo $0 <package-release-dir> <checkpoint|successor>" >&2
  exit 2
fi
if [[ $# -ne 2 ]]; then
  echo "usage: $0 <package-release-dir> <checkpoint|successor>" >&2
  exit 2
fi

PACKAGE_DIR=$(realpath "$1")
RELEASE_KIND=$2
ROOT=/home/exedev/songs-v2
UNIT=/etc/systemd/system/songs-v2-api.service
case "${RELEASE_KIND}" in
  checkpoint)
    EXPECTED_BINARY_SHA=4e2e34972ee92164fd6f6a670fdd5eee96a18ef089d4b31232ed44880a3664cc
    EXPECTED_ARCHIVE_SHA=ac67e8ae4d4f5411ef17d47df1e78e9f7a23ce1402d8204889ac1393566bc906
    EXPECTED_UNIT_SHA=a1b1659d18660fe1ad297192ac703bbdf38d6b8d339824025a403a4aaa8bc1d3
    EXPECTED_BOOTSTRAP_SHA=a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f
    ;;
  successor)
    EXPECTED_BINARY_SHA=fec8ac53063bf8e67f63a65d1391aa064fca29fb85720d6374f11b4138290649
    EXPECTED_ARCHIVE_SHA=0d8a446d9d0fb8b019282aec86b8d9daea6be376aeebf91aacb6823381434c59
    EXPECTED_UNIT_SHA=d803aacd15b5a26ce3197e2e4988b29efa59e7288d83eeab628a35aff28c9ca6
    EXPECTED_BOOTSTRAP_SHA=a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f
    ;;
  *) echo "release kind must be checkpoint or successor" >&2; exit 2 ;;
esac
RELEASE_ID="p1-009-${RELEASE_KIND}-${EXPECTED_BINARY_SHA:0:17}"
RELEASE_DIR="${ROOT}/var/releases/${RELEASE_ID}"
EXPECTED_EXEC="${RELEASE_DIR}/songs-v2-api"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="${ROOT}/var/releases/backups/${STAMP}-before-${RELEASE_ID}"
TMP_BINARY=$(mktemp "${ROOT}/var/releases/.p1-009-binary.XXXXXX")
ROLLED_BACK=0

rollback_on_error() {
  local status=$?
  trap - ERR
  rm -f "${TMP_BINARY}"
  if [[ ${ROLLED_BACK} -eq 0 && -f ${BACKUP_DIR}/READY ]]; then
    echo "install failed; restoring ${BACKUP_DIR}" >&2
    if ! "${ROOT}/scripts/rollback_v2_phase1_release.sh" "${BACKUP_DIR}"; then
      echo "CRITICAL: automatic V2 rollback failed; V1 remains the required path" >&2
      exit 125
    fi
    ROLLED_BACK=1
  fi
  exit "${status}"
}
trap rollback_on_error ERR

systemctl is-active --quiet songs.service
curl -fsS --max-time 10 http://127.0.0.1:8000/ >/dev/null
[[ -f ${PACKAGE_DIR}/songs-v2-api-linux-amd64.xz ]]
[[ -f ${PACKAGE_DIR}/songs-v2-api.service ]]
[[ -f ${PACKAGE_DIR}/SHA256SUMS ]]
echo "${EXPECTED_ARCHIVE_SHA}  ${PACKAGE_DIR}/songs-v2-api-linux-amd64.xz" | sha256sum -c -
echo "${EXPECTED_UNIT_SHA}  ${PACKAGE_DIR}/songs-v2-api.service" | sha256sum -c -
(
  cd "${PACKAGE_DIR}"
  sha256sum -c SHA256SUMS
  xz -t songs-v2-api-linux-amd64.xz
)
xz -dc "${PACKAGE_DIR}/songs-v2-api-linux-amd64.xz" >"${TMP_BINARY}"
echo "${EXPECTED_BINARY_SHA}  ${TMP_BINARY}" | sha256sum -c -
grep -Fqx "ExecStart=${EXPECTED_EXEC} -listen 127.0.0.1:8001" "${PACKAGE_DIR}/songs-v2-api.service"
grep -Fqx "WorkingDirectory=${ROOT}" "${PACKAGE_DIR}/songs-v2-api.service"

install -d -m 0755 "${BACKUP_DIR}"
if [[ -f ${UNIT} ]]; then
  cp -a "${UNIT}" "${BACKUP_DIR}/songs-v2-api.service"
  PREVIOUS_EXEC=$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "${UNIT}")
  [[ ${PREVIOUS_EXEC} = /* && -f ${PREVIOUS_EXEC} ]]
  printf '%s\n' "${PREVIOUS_EXEC}" >"${BACKUP_DIR}/previous-binary-path"
  sha256sum "${PREVIOUS_EXEC}" | awk '{print $1}' >"${BACKUP_DIR}/previous-binary-sha256"
  cp -a "${PREVIOUS_EXEC}" "${BACKUP_DIR}/songs-v2-api"
  systemctl is-enabled --quiet songs-v2-api.service && echo enabled >"${BACKUP_DIR}/previous-enabled" || echo disabled >"${BACKUP_DIR}/previous-enabled"
  systemctl is-active --quiet songs-v2-api.service && echo active >"${BACKUP_DIR}/previous-active" || echo inactive >"${BACKUP_DIR}/previous-active"
else
  touch "${BACKUP_DIR}/FIRST_INSTALL"
fi
(
  cd "${BACKUP_DIR}"
  find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name READY -printf '%P\0' | sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum -c SHA256SUMS
  touch READY
)

if [[ -e ${RELEASE_DIR} ]]; then
  [[ -f ${EXPECTED_EXEC} ]]
  echo "${EXPECTED_BINARY_SHA}  ${EXPECTED_EXEC}" | sha256sum -c -
else
  install -d -m 0755 "${RELEASE_DIR}"
  install -m 0755 "${TMP_BINARY}" "${EXPECTED_EXEC}.new"
  mv "${EXPECTED_EXEC}.new" "${EXPECTED_EXEC}"
fi
rm -f "${TMP_BINARY}"
install -m 0644 "${PACKAGE_DIR}/songs-v2-api.service" "${UNIT}.new"
mv "${UNIT}.new" "${UNIT}"
systemctl daemon-reload
systemctl enable songs-v2-api.service
systemctl restart songs-v2-api.service
systemctl is-active --quiet songs-v2-api.service
[[ $(systemctl show -p ExecStart --value songs-v2-api.service) == *"${EXPECTED_EXEC}"* ]]
echo "${EXPECTED_BINARY_SHA}  ${EXPECTED_EXEC}" | sha256sum -c -

ROOT_STATUS=000
for _ in $(seq 1 30); do
  ROOT_STATUS=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
    -H 'X-ExeDev-UserID: checkpoint-local' \
    -H 'X-Forwarded-Proto: https' \
    -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8001' \
    http://127.0.0.1:8001/ 2>/dev/null || true)
  [[ ${ROOT_STATUS} == 200 ]] && break
  sleep 1
done
[[ ${ROOT_STATUS} == 200 ]]
MANIFEST_SHA=$(curl -fsS --max-time 10 \
  -H 'X-ExeDev-UserID: checkpoint-local' \
  -H 'X-Forwarded-Proto: https' \
  -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8001' \
  http://127.0.0.1:8001/api/v2/bootstrap/manifest | sha256sum | awk '{print $1}')
[[ ${MANIFEST_SHA} == "${EXPECTED_BOOTSTRAP_SHA}" ]]
systemctl is-active --quiet songs.service
curl -fsS --max-time 10 http://127.0.0.1:8000/ >/dev/null

trap - ERR
printf 'installed %s; rollback backup: %s\n' "${RELEASE_ID}" "${BACKUP_DIR}"
