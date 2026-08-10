import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { BootstrapClientError, type LeadSheetDocument, type SetListDocument, type VerifiedSnapshot } from "./bootstrap/types";
import { loadVerifiedSnapshot, preflightReviewedManifest, type SnapshotProgress } from "./bootstrap/load";
import "./styles.css";

const CACHE_PREFIX = "songs-v2-shell-";
const DATABASE_NAME = "songs-v2";

type LoadState =
  | { readonly status: "loading"; readonly progress: SnapshotProgress }
  | { readonly status: "ready"; readonly snapshot: VerifiedSnapshot }
  | { readonly status: "error"; readonly error: BootstrapClientError };

function useHashPath(): string {
  const read = () => {
    const raw = window.location.hash.slice(1) || "/";
    try { return new URL(raw, window.location.origin).pathname; } catch { return "/not-found"; }
  };
  const [path, setPath] = useState(read);
  useEffect(() => {
    const update = () => setPath(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return path;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const yes = () => setOnline(true);
    const no = () => setOnline(false);
    window.addEventListener("online", yes);
    window.addEventListener("offline", no);
    return () => { window.removeEventListener("online", yes); window.removeEventListener("offline", no); };
  }, []);
  return online;
}

export interface ServiceWorkerState {
  readonly state: "unsupported" | "installing" | "current" | "update-available";
  readonly message?: string | undefined;
  readonly apply: () => Promise<void>;
}

function useServiceWorker(): ServiceWorkerState {
  const [state, setState] = useState<"unsupported" | "installing" | "current" | "update-available">("installing");
  const [message, setMessage] = useState<string>();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const applying = useRef(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) { setState("unsupported"); return; }
    const controllerChanged = () => { if (applying.current) window.location.reload(); };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    let alive = true;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((next) => {
      if (!alive) return;
      setRegistration(next);
      setState(next.waiting ? "update-available" : "current");
      next.addEventListener("updatefound", () => {
        const worker = next.installing;
        if (worker === null) return;
        setState("installing");
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") setState(navigator.serviceWorker.controller === null ? "current" : "update-available");
        });
      });
    }).catch(() => { if (alive) setState("unsupported"); });
    return () => { alive = false; navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged); };
  }, []);
  const apply = async () => {
    setMessage(undefined);
    try {
      await preflightReviewedManifest();
    } catch {
      setMessage("Update deferred: reconnect to the authenticated V2 API before reloading.");
      return;
    }
    if (registration?.waiting === undefined || registration.waiting === null) {
      setMessage("The waiting update is no longer available.");
      return;
    }
    applying.current = true;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  };
  return { state, ...(message === undefined ? {} : { message }), apply };
}

function Link({ to, children, className }: { readonly to: string; readonly children: ReactNode; readonly className?: string | undefined }) {
  return <a href={`#${to}`} className={className}>{children}</a>;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return <button className="icon-button" type="button" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`}><span aria-hidden="true">{theme === "dark" ? "◐" : theme === "light" ? "☀" : "◒"}</span></button>;
}

function Header({ path, online, update }: { readonly path: string; readonly online: boolean; readonly update: ReturnType<typeof useServiceWorker> }) {
  const current = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return <header className="site-header">
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="brand-row">
      <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">KGL</span><span><strong>Songs</strong><small>Verified read-only V2</small></span></Link>
      <div className="header-actions">
        <span className={`connection ${online ? "online" : "offline"}`}><span aria-hidden="true">●</span>{online ? "Online" : "Offline"}</span>
        {update.state === "update-available" && <button type="button" className="update-button" onClick={update.apply} disabled={!online} title={online ? "Activate the verified shell update" : "Reconnect before activating this update"}>{online ? "Update ready" : "Update waiting for connection"}</button>}
        <ThemeToggle />
      </div>
    </div>
    <nav aria-label="Primary">
      <Link to="/" className={path === "/" ? "active" : undefined}>Library</Link>
      <Link to="/songs" className={current("/songs") ? "active" : undefined}>Songs</Link>
      <Link to="/sets" className={current("/sets") ? "active" : undefined}>Set Lists</Link>
      <Link to="/status" className={current("/status") ? "active" : undefined}>Status</Link>
    </nav>
    {update.message && <p className="update-message" role="status">{update.message}</p>}
  </header>;
}

function Loading({ progress }: { readonly progress: SnapshotProgress }) {
  const label = progress.phase === "manifest" ? "Checking reviewed manifest" : progress.phase === "chunks" ? "Downloading verified chunks" : "Verifying source and Apex content";
  return <section className="state-card loading-state" aria-labelledby="loading-title">
    <p className="eyebrow">Private read-only pilot</p>
    <h1 id="loading-title">Preparing the verified songbook</h1>
    <p>Nothing is shown until the complete snapshot passes its reviewed hash chain.</p>
    <progress className="progress-track" max={Math.max(progress.total, 1)} value={progress.completed} aria-label={`${label}: ${progress.completed} of ${progress.total}`} />
    <p role="status" aria-live="polite"><strong>{label}</strong> · {progress.completed} of {progress.total}</p>
    <div className="skeleton-grid" aria-hidden="true"><span /><span /><span /><span /></div>
  </section>;
}

function ErrorState({ error, retry }: { readonly error: BootstrapClientError; readonly retry: () => void }) {
  const offline = error.code === "NETWORK_OFFLINE";
  const auth = error.code === "UNAUTHENTICATED";
  return <section className="state-card error-state" role="alert" aria-labelledby="error-title">
    <p className="eyebrow">{offline ? "Offline" : auth ? "Authentication required" : "Verification stopped"}</p>
    <h1 id="error-title">{offline ? "No saved snapshot yet" : auth ? "Sign in to open the private songbook" : "The snapshot was not opened"}</h1>
    <p>{error.message}</p>
    <p className="error-code">Error code: <code>{error.code}</code></p>
    <button type="button" className="primary-button" onClick={retry}>Try again</button>
  </section>;
}

function PageHeading({ eyebrow, title, children }: { readonly eyebrow: string; readonly title: string; readonly children?: ReactNode }) {
  return <div className="page-heading"><p className="eyebrow">{eyebrow}</p><h1 tabIndex={-1} data-page-heading>{title}</h1>{children}</div>;
}

function LibraryPage({ snapshot }: { readonly snapshot: VerifiedSnapshot }) {
  const recentSets = snapshot.setLists.slice(-6).reverse();
  const songHighlights = snapshot.leadSheets.slice(0, 12);
  return <>
    <PageHeading eyebrow="Reviewed snapshot" title="Your gig book, without the edit controls"><p>{snapshot.manifest.counts.lead_sheets} songs and {snapshot.manifest.counts.set_lists} Set Lists are loaded only after full verification.</p></PageHeading>
    <section className="metric-grid" aria-label="Snapshot summary">
      <div><strong>{snapshot.manifest.counts.lead_sheets}</strong><span>Lead sheets</span></div>
      <div><strong>{snapshot.manifest.counts.set_lists}</strong><span>Set Lists</span></div>
      <div><strong>{snapshot.manifest.counts.set_entries.toLocaleString()}</strong><span>Resolved entries</span></div>
      <div><strong>12/12</strong><span>Chunks verified</span></div>
    </section>
    <div className="dashboard-grid">
      <section className="panel"><div className="section-title"><div><p className="eyebrow">Browse</p><h2>Songs</h2></div><Link to="/songs">View all</Link></div><ul className="document-list compact">{songHighlights.map((song) => <SongRow key={song.id} song={song} snapshot={snapshot} />)}</ul></section>
      <section className="panel"><div className="section-title"><div><p className="eyebrow">Current archive</p><h2>Set Lists</h2></div><Link to="/sets">View all</Link></div><ul className="document-list compact">{recentSets.map((setList) => <SetRow key={setList.id} setList={setList} />)}</ul></section>
    </div>
  </>;
}

function SongRow({ song, snapshot }: { readonly song: LeadSheetDocument; readonly snapshot: VerifiedSnapshot }) {
  const route = snapshot.songRouteById.get(song.id);
  const landscape = song.fit.profiles.find((profile) => profile.profile === "ipad-landscape");
  return <li><Link to={`/songs/${route?.slug ?? song.slug}`}><span><strong>{song.projection.title}</strong><small>{song.projection.metadata.artist || "Artist not listed"}</small></span><span className={`fit-dot ${landscape?.status === "needs-editing" ? "warning" : "good"}`}>{landscape?.status === "needs-editing" ? "Landscape warning" : "Fit checked"}</span></Link></li>;
}

function SetRow({ setList }: { readonly setList: SetListDocument }) {
  return <li><Link to={`/sets/${setList.slug}`}><span><strong>{setList.projection.title}</strong><small>{[setList.projection.metadata.date, setList.projection.metadata.location].filter(Boolean).join(" · ")}</small></span><span className="entry-count">{setList.projection.entries.length}</span></Link></li>;
}

function SongsPage({ snapshot }: { readonly snapshot: VerifiedSnapshot }) {
  const [filter, setFilter] = useState("");
  const songs = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query === "" ? snapshot.leadSheets : snapshot.leadSheets.filter((song) => `${song.projection.title} ${song.projection.metadata.artist}`.toLocaleLowerCase().includes(query));
  }, [filter, snapshot.leadSheets]);
  return <>
    <PageHeading eyebrow="Lead sheets" title="Songs"><p>Authoritative Apex HTML from the reviewed source snapshot.</p></PageHeading>
    <label className="filter-field"><span>Filter loaded songs</span><input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Title or artist" /></label>
    <p className="result-count" role="status">Showing {songs.length} of {snapshot.leadSheets.length}</p>
    <ul className="document-list panel">{songs.map((song) => <SongRow key={song.id} song={song} snapshot={snapshot} />)}</ul>
  </>;
}

function SetsPage({ snapshot }: { readonly snapshot: VerifiedSnapshot }) {
  return <><PageHeading eyebrow="Performance archive" title="Set Lists"><p>Every entry resolves to an immutable lead-sheet identity.</p></PageHeading><ul className="document-list panel">{[...snapshot.setLists].reverse().map((setList) => <SetRow key={setList.id} setList={setList} />)}</ul></>;
}

function MetaItem({ label, value }: { readonly label: string; readonly value?: string | undefined }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function apexPresentationHtml(html: string): string {
  return html
    .replace(/^<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, "")
    .replace(' style="list-style-type: upper-alpha"', ' class="apex-upper-alpha"');
}

function ApexSheet({ song, snapshot }: { readonly song: LeadSheetDocument; readonly snapshot: VerifiedSnapshot }) {
  const html = useMemo(() => apexPresentationHtml(song.apex.html), [song.apex.html]);
  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    const href = target?.getAttribute("href");
    if (href?.startsWith("/song/")) {
      event.preventDefault();
      const slug = href.slice(6);
      if (snapshot.routeByKey.has(`song:${slug}`)) window.location.hash = `#/songs/${encodeURIComponent(slug)}`;
    }
  };
  return <>
    <h2 className="visually-hidden">Lead sheet sections</h2>
    <section className="apex-sheet" aria-label={`${song.projection.title} lead sheet`} data-authority="apex" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
  </>;
}

function LeadSheetPage({ song, snapshot }: { readonly song: LeadSheetDocument; readonly snapshot: VerifiedSnapshot }) {
  const fit = Object.fromEntries(song.fit.profiles.map((profile) => [profile.profile, profile]));
  return <article className="detail-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/songs">Songs</Link><span aria-hidden="true">/</span><span>{song.projection.title}</span></nav>
    <header className="detail-header">
      <div><p className="eyebrow">Verified lead sheet</p><h1 tabIndex={-1} data-page-heading>{song.projection.title}</h1><p className="artist">{song.projection.metadata.artist}</p></div>
      <div className="fit-summary" aria-label="Fit evidence"><span className="good">Portrait fit</span><span className={fit["ipad-landscape"]?.status === "needs-editing" ? "warning" : "good"}>{fit["ipad-landscape"]?.status === "needs-editing" ? "Landscape needs editing" : "Landscape fit"}</span><span>Phone scrolls</span></div>
    </header>
    <dl className="metadata-grid">
      <MetaItem label="Performance key" value={song.projection.metadata.performanceKey} />
      <MetaItem label="BPM" value={song.projection.metadata.bpm} />
      <MetaItem label="Original key" value={song.projection.metadata.originalKey} />
      <MetaItem label="Original BPM" value={song.projection.metadata.originalBpm} />
    </dl>
    <div className="authority-note"><strong>Renderer authority:</strong> Apex output verified against source <code>{song.source.sha256.slice(0, 12)}…</code>. No browser Markdown renderer is present.</div>
    <ApexSheet song={song} snapshot={snapshot} />
    <p className="back-link"><Link to="/songs">← Back to songs</Link></p>
  </article>;
}

function SetListPage({ setList, snapshot }: { readonly setList: SetListDocument; readonly snapshot: VerifiedSnapshot }) {
  const entryById = new Map(setList.projection.entries.map((entry) => [entry.id, entry]));
  return <article className="detail-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/sets">Set Lists</Link><span aria-hidden="true">/</span><span>{setList.projection.title}</span></nav>
    <header className="detail-header"><div><p className="eyebrow">Read-only Set List</p><h1 tabIndex={-1} data-page-heading>{setList.projection.title}</h1><p className="artist">{[setList.projection.metadata.date, setList.projection.metadata.location].filter(Boolean).join(" · ")}</p></div><span className="set-total">{setList.projection.entries.length} songs</span></header>
    {setList.projection.metadata.reviewRequired && <p className="warning-banner">This frozen Set List is marked review required.</p>}
    <div className="set-sections">{setList.projection.sections.map((section) => <section key={section.projectionKey} className="set-section"><h2>{section.heading || `Set ${section.ordinal}`}</h2><ol>{section.entryIds.map((entryId) => {
      const entry = entryById.get(entryId);
      if (entry === undefined) return <li key={entryId} className="missing-entry">Missing frozen entry {entryId}</li>;
      const target = snapshot.documentsById.get(entry.targetLeadSheetId);
      const route = snapshot.songRouteById.get(entry.targetLeadSheetId);
      return <li key={entry.id} className={entry.columnBreakBefore ? "column-break" : undefined}><span className="ordinal">{entry.ordinal}</span><div><strong>{route && target?.kind === "lead-sheet" ? <Link to={`/songs/${route.slug}`}>{entry.label}</Link> : entry.label}</strong>{entry.singer && <span className="entry-detail"><b>Singer</b> {entry.singer}</span>}{entry.note && <span className="entry-detail"><b>Note</b> {entry.note}</span>}</div></li>;
    })}</ol></section>)}</div>
  </article>;
}

function StatusPage({ snapshot, online, update }: { readonly snapshot: VerifiedSnapshot; readonly online: boolean; readonly update: ReturnType<typeof useServiceWorker> }) {
  return <><PageHeading eyebrow="Diagnostics" title="Snapshot status"><p>Software evidence only. Physical Safari/iPad acceptance is still pending.</p></PageHeading><dl className="status-grid panel">
    <MetaItem label="Generation" value={snapshot.manifest.generation} />
    <MetaItem label="Source commit" value={snapshot.manifest.source_baseline.commit} />
    <MetaItem label="Snapshot SHA-256" value={snapshot.manifest.snapshot_sha256} />
    <MetaItem label="Network" value={online ? "Online" : "Offline — current snapshot remains in memory"} />
    <MetaItem label="Service worker" value={update.state} />
    <MetaItem label="Shell cache prefix" value={CACHE_PREFIX} />
    <MetaItem label="Reserved IndexedDB" value={`${DATABASE_NAME} (not opened until P1-005)`} />
    <MetaItem label="Physical iPad" value="Pending" />
  </dl></>;
}

function decodedRouteSegment(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function ReadyApp({ snapshot, online, update }: { readonly snapshot: VerifiedSnapshot; readonly online: boolean; readonly update: ReturnType<typeof useServiceWorker> }) {
  const path = useHashPath();
  useEffect(() => { document.querySelector<HTMLElement>("[data-page-heading]")?.focus(); window.scrollTo({ top: 0, behavior: "auto" }); }, [path]);
  let page: ReactNode;
  if (path === "/") page = <LibraryPage snapshot={snapshot} />;
  else if (path === "/songs") page = <SongsPage snapshot={snapshot} />;
  else if (path === "/sets") page = <SetsPage snapshot={snapshot} />;
  else if (path === "/status") page = <StatusPage snapshot={snapshot} online={online} update={update} />;
  else if (path.startsWith("/songs/")) {
    const slug = decodedRouteSegment(path.slice(7));
    const route = slug === undefined ? undefined : snapshot.routeByKey.get(`song:${slug}`);
    const document = route ? snapshot.documentsById.get(route.documentId) : undefined;
    page = document?.kind === "lead-sheet" ? <LeadSheetPage song={document} snapshot={snapshot} /> : <NotFound />;
  } else if (path.startsWith("/sets/")) {
    const slug = decodedRouteSegment(path.slice(6));
    const route = slug === undefined ? undefined : snapshot.routeByKey.get(`set:${slug}`);
    const document = route ? snapshot.documentsById.get(route.documentId) : undefined;
    page = document?.kind === "set-list" ? <SetListPage setList={document} snapshot={snapshot} /> : <NotFound />;
  } else page = <NotFound />;
  return <><Header path={path} online={online} update={update} /><main id="main">{!online && <div className="offline-banner" role="status">Offline — using the verified in-memory snapshot. Reload requires a connection until P1-005.</div>}{page}</main><Footer snapshot={snapshot} /></>;
}

function NotFound() { return <section className="state-card"><p className="eyebrow">V2 route</p><h1 tabIndex={-1} data-page-heading>Page not found</h1><p>This isolated shell does not fall through to v1.</p><Link to="/" className="primary-button">Return to library</Link></section>; }

function Footer({ snapshot }: { readonly snapshot: VerifiedSnapshot }) { return <footer><span>Read-only pilot</span><span>{snapshot.manifest.generation}</span><span>Physical iPad: pending</span></footer>; }

export class ShellErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error("V2 shell render failure", error, info.componentStack); }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main id="main"><section className="state-card error-state" role="alert"><p className="eyebrow">V2 shell failure</p><h1>Unable to display this route</h1><p>The verified snapshot remains read-only. Reload the isolated V2 shell to recover.</p><button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload V2</button></section></main>;
  }
}

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading", progress: { phase: "manifest", completed: 0, total: 1 } });
  const online = useOnline();
  const update = useServiceWorker();
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setState({ status: "loading", progress: { phase: "manifest", completed: 0, total: 1 } });
    loadVerifiedSnapshot({ signal: controller.signal, onProgress: (progress) => { if (alive) setState({ status: "loading", progress }); } }).then((snapshot) => { if (alive) setState({ status: "ready", snapshot }); }).catch((error: unknown) => {
      if (controller.signal.aborted || !alive) return;
      setState({ status: "error", error: error instanceof BootstrapClientError ? error : new BootstrapClientError("API_PROTOCOL_INVALID", "An unexpected bootstrap error occurred", error) });
    });
    return () => { alive = false; controller.abort(); };
  }, [attempt]);
  if (state.status === "ready") return <ReadyApp snapshot={state.snapshot} online={online} update={update} />;
  return <><Header path="/" online={online} update={update} /><main id="main">{state.status === "loading" ? <Loading progress={state.progress} /> : <ErrorState error={state.error} retry={() => setAttempt((value) => value + 1)} />}</main></>;
}
