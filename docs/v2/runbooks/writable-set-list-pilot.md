# Writable Set List pilot

**Activated:** August 23, 2026

**Owner authorization:** explicit request to enable Set List writing

**Origin:** `https://kgl-songs.exe.xyz:8003/#/`

## Active boundary

- V1 remains the default/fallback on port 8000.
- V2 Set List authoring and foreground sync are enabled on compact origin port 8003.
- The stale port-8001 and port-8002 pilot services are disabled so cached test shells cannot be mistaken for the active writable app.
- Lead-sheet authoring, lyrics providers, and Shelley suggestions remain disabled.
- Formal TASK-021 physical acceptance, default-route cutover, and V1 retirement remain pending.
- The writable archive uses remote branch `refs/heads/v2-published`, seeded from
  `v2-phase1-content-2026-08-10` at `17c326c` so the reviewed bootstrap and Git
  bytes match exactly. It does not publish directly to `main`.

## Runtime

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
  -H 'X-Forwarded-Host: kgl-songs.exe.xyz:8003' \
  http://127.0.0.1:8003/api/v2/writable-capabilities
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
