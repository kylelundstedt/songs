# TASK-020 offline writable lead-sheet evidence

This packet is generated deterministically from the reviewed 339-lead-sheet
corpus and the production browser domain/storage implementation. It proves
exact source preservation, surgical metadata edits, durable invalid workspaces,
server-validation receipts, byte-stable outbox envelopes, and hashed
credential-free recovery.

Online provider, Shelley, authentication, same-origin, and Apex behavior is
covered by the hermetic `internal/v2author` race-enabled test suite. The helper
endpoints return review candidates only and have no sync, Git, or publication
write dependency.

The checked evidence SHA-256 is
`1743d4bebde58de9165525259b47dc2399b651a2a6e742768e8bbccb2a51ece6`.

Verify with:

```sh
make v2-writable-lead-sheet-check
```
