#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${SONGS_BASE_URL:-http://127.0.0.1:8000}}"
CURL=(curl -fsS --max-time 30)
if [[ -n "${SONGS_SMOKE_USER_ID:-}" ]]; then CURL+=(-H "X-ExeDev-UserID: ${SONGS_SMOKE_USER_ID}"); fi
if [[ -n "${SONGS_SMOKE_EMAIL:-}" ]]; then CURL+=(-H "X-ExeDev-Email: ${SONGS_SMOKE_EMAIL}"); fi

get() { "${CURL[@]}" "${BASE_URL}$1"; }

health=''
for _ in {1..30}; do
  if health="$(get '/healthz?deep=1' 2>/dev/null)" && [[ "$(jq -r '.ok' <<<"$health")" == "true" ]]; then break; fi
  health=''
  sleep 1
done
[[ -n "$health" ]] || { echo "health check did not become ready" >&2; exit 1; }

songs="$(jq -r '.songs' <<<"$health")"
sets="$(jq -r '.sets' <<<"$health")"
resources="$(jq -r '.offline_resources' <<<"$health")"
bytes="$(jq -r '.offline_bytes' <<<"$health")"
[[ "$songs" -gt 0 && "$sets" -gt 0 && "$resources" -ge $((songs + 2 * sets + 9)) && "$bytes" -gt 0 ]] || {
  echo "unexpected health counts: songs=$songs sets=$sets resources=$resources bytes=$bytes" >&2
  exit 1
}
if [[ -n "${SONGS_EXPECT_RELEASE:-}" && "$(jq -r '.release' <<<"$health")" != "$SONGS_EXPECT_RELEASE" ]]; then
  echo "release mismatch: expected=$SONGS_EXPECT_RELEASE actual=$(jq -r '.release' <<<"$health")" >&2
  exit 1
fi

home="$(get '/songs')"
grep -q 'id="song-list"' <<<"$home"
song_id="$(get '/api/catalog' | jq -er '.[0].id')"
grep -q 'data-lead-sheet' <<<"$(get "/song/${song_id}")"

set_index="$(get '/set-lists')"
set_path="$(grep -oE 'href="/sets/[^"]+"' <<<"$set_index" | head -1 | cut -d'"' -f2)"
[[ -n "$set_path" ]] || { echo "no Set List route found" >&2; exit 1; }
grep -q 'data-set-sheet' <<<"$(get "$set_path")"
grep -q 'data-live-panel' <<<"$(get "${set_path}/live")"

manifest="$(get '/api/offline/library')"
[[ "$(jq -r '.resource_count' <<<"$manifest")" == "$resources" ]]
fetch_url="$(jq -er '.resources[] | select(.url=="/songs") | .fetch_url' <<<"$manifest")"
expected_hash="$(jq -er '.resources[] | select(.url=="/songs") | .fingerprint' <<<"$manifest")"
actual_hash="$(get "$fetch_url" | sha256sum | awk '{print $1}')"
[[ "$actual_hash" == "$expected_hash" ]] || { echo "offline resource hash mismatch" >&2; exit 1; }

echo "V1 smoke test passed: commit=$(jq -r '.commit' <<<"$health") songs=$songs sets=$sets offline_resources=$resources"
