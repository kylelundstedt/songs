#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO="${GO:-/usr/local/go/bin/go}"
PORT="${SONGS_RESTORE_PORT:-8099}"
TMP="$(mktemp -d /tmp/songs-restore-drill.XXXXXX)"
PID=''
cleanup() {
  if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

cd "$ROOT"
git fsck --full
git fetch origin main --quiet
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
[[ "$local_head" == "$remote_head" ]] || { echo "origin/main does not match the deployed checkout" >&2; exit 1; }

remote="$(git remote get-url origin)"
git clone --quiet "$remote" "$TMP/repo"
cd "$TMP/repo"
[[ "$(git rev-parse HEAD)" == "$remote_head" ]] || { echo "restored repository revision mismatch" >&2; exit 1; }
"$GO" test ./...
node srv/static/sw_test.js
"$GO" build -o "$TMP/songs" ./cmd/srv

SONGS_ASSET_ROOT="$TMP/repo/srv" SONGS_RELEASE_ID="$remote_head" SONGS_OWNER_EMAIL="${SONGS_OWNER_EMAIL:-klundstedt@industryvault.com}" "$TMP/songs" -listen "127.0.0.1:$PORT" -repo "$TMP/repo" -db "$TMP/restore.sqlite3" >"$TMP/server.log" 2>&1 &
PID=$!
SONGS_EXPECT_RELEASE="$remote_head" SONGS_BASE_URL="http://127.0.0.1:$PORT" "$TMP/repo/scripts/smoke-test.sh"

echo "remote restore drill passed: commit=${remote_head:0:12}"
