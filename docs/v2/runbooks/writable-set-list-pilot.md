# Writable Set List pilot — disabled

**Activated:** August 23, 2026

**Owner no-go:** August 26, 2026

**Origin:** disabled; no V2 service is listening

## Final boundary

- V1 is the only operational application on port 8000.
- `songs-v2-writable.service` is disabled and inactive.
- No V2 writable, cutover, or V1-retirement claim is authorized.
- Preserved state is under `var/deploy-backups/20260826T190609Z-v2-no-go/`.
- The writable archive remains on remote branch `refs/heads/v2-published`; it was not merged into `main`.
- Do not reactivate this pilot without a fresh owner-approved plan grounded in V1's accepted UI and workflows.

## Historical runtime

- API release: `var/releases/writable-editor-e67feecd20fe1333/songs-v2-api`
- API SHA-256: `e67feecd20fe13339fae1a0f942b42d027f262a6cdf443073ca42e6bad0d615a`
- Publisher SHA-256: `3c26ba4bb8e84e847867fe191fbf77b49a5e8704145d6294fce44673806540fa`
- Shell release: `shell-c9f7a346b089bb849b1ba8ba`
- Sync ledger: `var/writable/sync.sqlite3`
- Publication ledger: `var/writable/publication.sqlite3`
- Master key: `var/writable/sync-master-key`, mode `0600`; never commit or copy
  it into diagnostics.
- Publication workspace/lock: `var/writable/git-work` and
  `var/writable/publication.lock`.

The reviewed bootstrap contains 373 documents and 373 published baseline
mappings. Before opening the pilot, the existing `Kashmir` lead sheet from
canonical `main` was imported through the durable revision/publication path.
The active server therefore contains 374 documents, 374 published mappings,
and zero open conflicts. The owner's browser registers its own device on first
writable use. Every edit is committed locally before foreground sync.

## Owner activation

Close every existing V2 Safari tab and Home Screen instance so the waiting
service worker can activate. Reopen V2 online, confirm that a Set List has an
**Edit Set List** action and that the recovery/sync toolbar is visible, then run
**Sync now** once before editing. This initial pull makes the published
`Kashmir` lead sheet available to the Set List editor.

Before material browser cleanup or device replacement, use **Export recovery**.
Keep the exported JSON until the edit is acknowledged and published.

## Publication

`Sync now` sends the durable revision to the server but deliberately does not
push Git automatically. List server-accepted Set Lists awaiting publication:

```sh
scripts/publish_v2_set_list.py
```

Publish exactly one reviewed document:

```sh
scripts/publish_v2_set_list.py --publish DOCUMENT_ID
```

The command validates the Set List, commits it to `v2-published`, records the
publication mapping, and emits the sync publication event. The browser must run
**Sync now** again to receive the published state before locked Live uses it.

## Verification

```sh
systemctl is-active songs.service songs-v2-api.service
curl -fsS \
  -H 'X-ExeDev-Email: klundstedt@industryvault.com' \
  -H 'X-Forwarded-Proto: https' \
  -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8004' \
  http://127.0.0.1:8004/api/v2/writable-capabilities
```

Expected capability state: Set List authoring and foreground sync `true`; every
lead-sheet/enrichment capability `false`.

## Rollback

1. Ask every reachable browser to **Export recovery**.
2. Restore the service unit from the pre-writable deployment backup under
   `var/deploy-backups/20260823T183759Z-pre-writable/`.
3. Run `systemctl daemon-reload` and restart `songs-v2-api.service`.
4. Verify V1 first, then read-only V2.
5. Preserve `var/writable/`; disabling controls must never delete authored state.
