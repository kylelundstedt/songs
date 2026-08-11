import "../v2/packages/web/src/styles.css";
import "./live-fit-harness.css";
import { fitLiveLeadSheet } from "../v2/packages/web/src/live/fitter";
import type { FitResult, LeadSheetDocument } from "../v2/packages/web/src/bootstrap/types";

interface HarnessSong {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly html: string;
  readonly fit: readonly FitResult[];
}

interface CaptureResult {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly body_px: number;
  readonly line_height: number;
  readonly column_count: number;
  readonly viewport: { readonly client_width: number; readonly client_height: number; readonly scroll_width: number; readonly scroll_height: number };
  readonly columns: readonly { readonly client_width: number; readonly client_height: number; readonly scroll_width: number; readonly scroll_height: number }[];
  readonly expected: FitResult;
}

type ProfileName = "ipad-portrait" | "ipad-landscape" | "phone";

const profiles = Object.freeze({
  "ipad-portrait": { formFactor: "tablet" as const, className: "fit-harness-ipad-portrait" },
  "ipad-landscape": { formFactor: "tablet" as const, className: "fit-harness-ipad-landscape" },
  phone: { formFactor: "phone" as const, className: "fit-harness-phone" },
});

async function loadSongs(): Promise<readonly HarnessSong[]> {
  const manifest = await fetch("/internal/v2bootstrap/data/manifest.json", { cache: "no-store" }).then((response) => response.json());
  const chunks = await Promise.all(manifest.chunks.map((chunk: { readonly path: string }) => fetch(`/internal/v2bootstrap/data/chunks/${chunk.path}`, { cache: "no-store" }).then((response) => response.json())));
  return chunks.flatMap((chunk: { readonly documents: readonly LeadSheetDocument[] }) => chunk.documents)
    .filter((document: LeadSheetDocument) => document.kind === "lead-sheet")
    .map((document: LeadSheetDocument) => ({
      id: document.id,
      slug: document.slug,
      title: document.projection.title,
      html: document.apex.html,
      fit: document.fit.profiles,
    }));
}

const songs = await loadSongs();
const viewport = document.querySelector<HTMLElement>("#fit-harness-viewport")!;
const source = document.querySelector<HTMLElement>("#fit-harness-source")!;
const columns = document.querySelector<HTMLElement>("#fit-harness-columns")!;

async function captureLiveFit(profileName: ProfileName): Promise<{ readonly profile: ProfileName; readonly count: number; readonly observed: object; readonly results: readonly CaptureResult[] }> {
  const profile = profiles[profileName];
  viewport.className = `locked-live-sheet-viewport fit-harness-viewport ${profile.className}`;
  const results: CaptureResult[] = [];
  for (const song of songs) {
    source.innerHTML = song.html;
    columns.replaceChildren();
    const result = await fitLiveLeadSheet({ source, viewport, columns }, { formFactor: profile.formFactor });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const expected = song.fit.find((fit) => fit.profile === profileName);
    if (expected === undefined) throw new Error(`missing ${profileName} fit evidence for ${song.id}`);
    results.push({
      id: song.id,
      slug: song.slug,
      title: song.title,
      status: result.status,
      body_px: result.bodyPx,
      line_height: result.lineHeight,
      column_count: result.columnCount,
      viewport: { client_width: viewport.clientWidth, client_height: viewport.clientHeight, scroll_width: viewport.scrollWidth, scroll_height: viewport.scrollHeight },
      columns: [...columns.querySelectorAll<HTMLElement>(".live-column")].map((column) => ({ client_width: column.clientWidth, client_height: column.clientHeight, scroll_width: column.scrollWidth, scroll_height: column.scrollHeight })),
      expected,
    });
  }
  return {
    profile: profileName,
    count: results.length,
    observed: { inner_width: innerWidth, inner_height: innerHeight, device_pixel_ratio: devicePixelRatio, user_agent: navigator.userAgent, platform: navigator.platform, max_touch_points: navigator.maxTouchPoints },
    results,
  };
}

declare global {
  interface Window { captureLiveFit: typeof captureLiveFit }
}
window.captureLiveFit = captureLiveFit;
