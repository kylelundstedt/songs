import { useEffect, useState } from "react";
import { buildLeadSheetPublicationPayload, validateLeadSheetLocally } from "../leadsheets/codec";
import { validateLeadSheet } from "../leadsheets/model";
import { buildSetListPublicationPayload, decodeCanonicalSetListSource } from "../setlists/codec";
import { randomStableId } from "../setlists/model";
import { openSongsStorage } from "../storage";
import {
  buildAuthoredConflictResolution,
  isAuthoredResolutionOutboxRecord,
  type AnyAuthoredServerRevisionRecord,
  type AuthoredConflictRecord,
  type AuthoredConflictResolutionMode,
  type AuthoredResolutionOutboxRecord,
  type AuthoredSyncStateRecord,
} from "../storage/authored";

interface ConflictReview {
  readonly conflict: AuthoredConflictRecord;
  readonly current: AnyAuthoredServerRevisionRecord;
  readonly head: AnyAuthoredServerRevisionRecord;
  readonly candidate: AnyAuthoredServerRevisionRecord;
  readonly reviewedLocalRevisionId: string;
  readonly queued?: AuthoredResolutionOutboxRecord;
}

async function loadReviews(conflictId?: string): Promise<{ readonly reviews: readonly ConflictReview[]; readonly sync: AuthoredSyncStateRecord | null }> {
  const storage = await openSongsStorage();
  try {
    const state = await storage.readAuthoredState();
    const revisions = new Map(state.revisions.filter((item): item is AnyAuthoredServerRevisionRecord => item.origin === "server").map((item) => [item.id, item]));
    const resolutionByConflict = new Map(state.outbox.filter(isAuthoredResolutionOutboxRecord).map((item) => [item.conflictId, item]));
    const reviews = state.conflicts
      .filter((item) => (item.status === "open" || resolutionByConflict.has(item.id)) && (conflictId === undefined || item.id === conflictId))
      .map((conflict) => {
        const current = revisions.get(conflict.currentRevisionId);
        const candidate = revisions.get(conflict.candidateRevisionId);
        if (current === undefined || candidate === undefined) throw new Error(`Conflict ${conflict.id} is missing a retained candidate`);
        const headId = state.sync?.documents.find((item) => item.documentId === conflict.documentId)?.currentServerRevisionId ?? current.id;
        const head = revisions.get(headId);
        if (head === undefined) throw new Error(`Conflict ${conflict.id} is missing the latest server head`);
        const reviewedLocalRevisionId = state.drafts.find((item) => item.documentId === conflict.documentId)?.localRevisionId ?? "";
        return { conflict, current, head, candidate, reviewedLocalRevisionId, ...(resolutionByConflict.get(conflict.id) === undefined ? {} : { queued: resolutionByConflict.get(conflict.id)! }) };
      });
    return { reviews, sync: state.sync };
  } finally { storage.close(); }
}

function manualPayload(review: ConflictReview, source: string): { readonly title: string; readonly payload: AnyAuthoredServerRevisionRecord["payload"] } {
  const path = review.head.payload.path;
  if (review.current.payload.kind === "set-list") {
    const document = decodeCanonicalSetListSource(source, path);
    return { title: document.title, payload: buildSetListPublicationPayload(document) };
  }
  const document = validateLeadSheet({ id: review.conflict.documentId, path, source });
  const validation = validateLeadSheetLocally(document);
  if (!validation.valid || validation.title === undefined) throw new Error("Manual lead-sheet resolution must pass local validation before it can be queued");
  return { title: validation.title, payload: buildLeadSheetPublicationPayload(document) };
}

function ConflictCard({ review, sync, writable, onChanged }: { readonly review: ConflictReview; readonly sync: AuthoredSyncStateRecord; readonly writable: boolean; readonly onChanged: () => void }) {
  const [manualSource, setManualSource] = useState(review.candidate.payload.source);
  const [message, setMessage] = useState(review.queued === undefined ? "No resolution selected." : `${review.queued.mode} resolution is ${review.queued.state}.`);
  const [busy, setBusy] = useState(false);
  const queue = async (mode: AuthoredConflictResolutionMode) => {
    if (!writable || busy || review.queued !== undefined || review.conflict.status !== "open") return;
    setBusy(true);
    const storage = await openSongsStorage();
    try {
      const record = await buildAuthoredConflictResolution(review.conflict, {
        deviceId: sync.deviceId,
        operationId: randomStableId("operation"),
        mode,
        currentRevision: review.current,
        candidateRevision: review.candidate,
        reviewedLocalRevisionId: review.reviewedLocalRevisionId,
        baseRevision: review.head,
        ...(mode === "manual" ? { manual: manualPayload(review, manualSource) } : {}),
        clientCursor: sync.cursor,
        createdAt: new Date().toISOString(),
      });
      await storage.enqueueAuthoredConflictResolution(record);
      localStorage.setItem("songs-v2-authored-recovery-present", "1");
      setMessage(`${mode} resolution saved durably and queued. Both original candidates remain retained.`);
      window.dispatchEvent(new Event("songs-v2-authored-change"));
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to queue conflict resolution"); }
    finally { storage.close(); setBusy(false); }
  };
  const renew = async () => {
    if (review.queued?.state !== "failed" || busy) return;
    setBusy(true);
    const storage = await openSongsStorage();
    try {
      await storage.discardFailedConflictResolution(review.queued.id);
      setMessage("Failed resolution intent removed. Re-review the latest server head before selecting a new resolution.");
      window.dispatchEvent(new Event("songs-v2-authored-change"));
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to reopen conflict review"); }
    finally { storage.close(); setBusy(false); }
  };
  const kind = review.current.payload.kind;
  return <article className="panel conflict-card" aria-busy={busy}>
    <header><p className="eyebrow">{kind === "set-list" ? "Set List" : "Lead sheet"} conflict</p><h2>{review.head.title}</h2><p><code>{review.conflict.id}</code> · document <code>{review.conflict.documentId}</code></p></header>
    <p className="warning-banner"><strong>{review.conflict.status === "open" ? "Explicit review required." : "Resolved by another accepted operation."}</strong> {review.conflict.status === "open" ? "Resolving creates a new immutable server revision." : "The local failed intent will not retry and may be dismissed after export/review."} The current and local candidates remain in recovery history and exports.</p>
    <div className="conflict-sides">
      <section><h3>{review.head.id === review.current.id ? "Current server candidate" : "Original server conflict side"}</h3><p><code>{review.current.id}</code></p><pre>{review.current.payload.source}</pre></section>
      {review.head.id !== review.current.id && <section><h3>Latest server head · renewed CAS base</h3><p><code>{review.head.id}</code></p><pre>{review.head.payload.source}</pre></section>}
      <section><h3>Local conflict candidate</h3><p><code>{review.candidate.id}</code></p><pre>{review.candidate.payload.source}</pre></section>
    </div>
    <p role="status" aria-live="polite" className="session-banner">{message}</p>
    {review.queued !== undefined ? <><dl className="status-grid"><div><dt>Selected resolution</dt><dd>{review.queued.mode}</dd></div><div><dt>Queue state</dt><dd>{review.queued.state}</dd></div><div><dt>CAS base</dt><dd><code>{review.queued.envelope.base_revision_id}</code></dd></div><div><dt>Operation</dt><dd><code>{review.queued.envelope.operation_id}</code></dd></div>{review.queued.lastError !== undefined && <div><dt>Last error</dt><dd>{review.queued.lastError}</dd></div>}</dl>{review.queued.state === "failed" && (review.queued.lastError?.startsWith("CONFLICT_CAS_FAILED:") || review.queued.lastError?.startsWith("SUPERSEDED:")) && <button type="button" disabled={!writable || busy} onClick={() => void renew()}>{review.conflict.status === "open" ? "Re-review latest server head" : "Dismiss superseded local intent"}</button>}</> : <>
      <div className="set-detail-actions"><button type="button" disabled={!writable || busy} onClick={() => void queue("keep-server")}>Keep server</button><button type="button" disabled={!writable || busy} onClick={() => void queue("keep-local")}>Keep local</button></div>
      <section className="conflict-manual"><h3>Resolve manually</h3><p>Start from the local candidate, review every byte, then queue one new resolution. Neither retained candidate is edited.</p><textarea aria-label={`Manual resolution source for ${review.head.title}`} spellCheck={false} value={manualSource} onChange={(event) => setManualSource(event.target.value)} /><button type="button" className="primary-button" disabled={!writable || busy} onClick={() => void queue("manual")}>Queue manual resolution</button></section>
    </>}
    {!writable && <p>Writing for this document kind is disabled. Review and export remain available; resolution submission is stopped.</p>}
  </article>;
}

export function ConflictReviewPage({ conflictId, setListWritable, leadSheetWritable }: { readonly conflictId?: string; readonly setListWritable: boolean; readonly leadSheetWritable: boolean }) {
  const [loaded, setLoaded] = useState<{ readonly reviews: readonly ConflictReview[]; readonly sync: AuthoredSyncStateRecord | null }>();
  const [error, setError] = useState<string>();
  const refresh = () => { void loadReviews(conflictId).then(setLoaded).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Unable to open conflicts")); };
  useEffect(refresh, [conflictId]);
  if (error !== undefined) return <section className="state-card" role="alert"><h1>Conflict review unavailable</h1><p>{error}</p></section>;
  if (loaded === undefined) return <section className="state-card" role="status"><h1>Opening durable conflicts…</h1></section>;
  if (loaded.sync === null) return <section className="state-card" role="alert"><h1>Conflict sync state unavailable</h1><p>Export recovery data before attempting repair.</p></section>;
  return <section className="detail-page"><div className="page-heading"><p className="eyebrow">Writable recovery</p><h1 tabIndex={-1} data-page-heading>Conflict review</h1><p>Compare both immutable server revisions, then explicitly keep local, keep server, or queue a manual resolution.</p></div>{loaded.reviews.length === 0 ? <section className="empty-state"><h2>No open conflicts</h2><p>Resolved conflict history remains in recovery exports.</p></section> : loaded.reviews.map((review) => <ConflictCard key={review.conflict.id} review={review} sync={loaded.sync!} writable={review.current.payload.kind === "set-list" ? setListWritable : leadSheetWritable} onChanged={refresh} />)}</section>;
}
