#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO="${GO:-/usr/local/go/bin/go}"
SERVICE="${SONGS_SERVICE:-songs}"
BASE_URL="${SONGS_BASE_URL:-http://127.0.0.1:8000}"
PREFLIGHT_PORT="${SONGS_PREFLIGHT_PORT:-8098}"
RELEASES_DIR="${SONGS_RELEASES_DIR:-$ROOT/var/releases}"
CURRENT_LINK="${SONGS_CURRENT_RELEASE:-$ROOT/var/current-release}"
LOCK_FILE="$ROOT/var/deploy-v1.lock"

mkdir -p "$ROOT/var" "$RELEASES_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another V1 deployment is already running" >&2; exit 1; }

cd "$ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo "refusing to deploy a dirty working tree" >&2; exit 1; }

"$GO" test ./...
node srv/static/sw_test.js
node --check srv/static/app.js
node --check srv/static/sw.js

commit="$(git rev-parse HEAD)"
release_id="${commit}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
staging="$RELEASES_DIR/.staging-$release_id"
release="$RELEASES_DIR/$release_id"
[[ ! -e "$release" ]] || { echo "release already exists: $release" >&2; exit 1; }
mkdir -p "$staging"
preflight_pid=''
cutover=0
success=0
previous=''
next_link="${CURRENT_LINK}.next"
preflight_db="$ROOT/var/preflight-$release_id.sqlite3"

cleanup() {
  if [[ -n "$preflight_pid" ]]; then kill "$preflight_pid" 2>/dev/null || true; wait "$preflight_pid" 2>/dev/null || true; fi
  rm -f "$preflight_db" "$preflight_db-shm" "$preflight_db-wal" "$next_link"
  if [[ -d "$staging" ]]; then rm -rf "$staging"; fi
}
rollback() {
  [[ "$cutover" == 1 && "$success" == 0 ]] || return
  echo "deployment failed; restoring previous V1 release" >&2
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -s "$previous" "$next_link"
    mv -Tf "$next_link" "$CURRENT_LINK"
    sudo systemctl restart "$SERVICE" || true
    previous_id="$(tr -d '\n' < "$previous/COMMIT" 2>/dev/null || true)"
    if SONGS_EXPECT_RELEASE="$previous_id" "$ROOT/scripts/smoke-test.sh" "$BASE_URL"; then
      echo "previous release restored: $previous" >&2
      return
    fi
  fi
  echo "automatic rollback could not verify the previous release" >&2
}
on_exit() { status=$?; rollback; cleanup; trap - EXIT; exit "$status"; }
trap on_exit EXIT

"$GO" build -o "$staging/songs" ./cmd/srv
install -d -m 0755 "$staging/templates" "$staging/static"
cp -R srv/templates/. "$staging/templates/"
cp -R srv/static/. "$staging/static/"
printf '%s\n' "$commit" > "$staging/COMMIT"
chmod 0755 "$staging/songs"
find "$staging/templates" "$staging/static" -type d -exec chmod 0755 {} +
find "$staging/templates" "$staging/static" -type f -exec chmod 0644 {} +
chmod 0444 "$staging/COMMIT"
mv -T "$staging" "$release"
chmod -R a-w "$release"

SONGS_ASSET_ROOT="$release" SONGS_OWNER_EMAIL="${SONGS_OWNER_EMAIL:-klundstedt@industryvault.com}" "$release/songs" -listen "127.0.0.1:$PREFLIGHT_PORT" -repo "$ROOT" -db "$preflight_db" >"$ROOT/var/preflight-$release_id.log" 2>&1 &
preflight_pid=$!
SONGS_EXPECT_RELEASE="$commit" "$ROOT/scripts/smoke-test.sh" "http://127.0.0.1:$PREFLIGHT_PORT"
kill "$preflight_pid" 2>/dev/null || true
wait "$preflight_pid" 2>/dev/null || true
preflight_pid=''

[[ -L "$CURRENT_LINK" ]] || { echo "no verified fallback release at $CURRENT_LINK" >&2; exit 1; }
previous="$(readlink -f "$CURRENT_LINK")"
[[ -d "$previous" && -r "$previous/COMMIT" ]] || { echo "fallback release is invalid: $previous" >&2; exit 1; }

sudo install -m 0644 "$ROOT/songs.service" /etc/systemd/system/songs.service
sudo systemctl daemon-reload
systemctl show "$SERVICE" -p ExecStart --value | grep -q '/var/current-release/songs' || { echo "installed service does not use the release symlink" >&2; exit 1; }

ln -s "$release" "$next_link"
mv -Tf "$next_link" "$CURRENT_LINK"
cutover=1
sudo systemctl restart "$SERVICE"
SONGS_EXPECT_RELEASE="$commit" "$ROOT/scripts/smoke-test.sh" "$BASE_URL"
success=1

echo "deployed V1 release $release_id"
echo "previous release: $previous"
