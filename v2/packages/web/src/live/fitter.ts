/**
 * The Live fitter consumes the verified Apex DOM already present in `source`.
 * It deliberately does not parse Markdown or write to the source/panel: the
 * only persistent DOM it changes is the supplied `[data-live-columns]` node.
 */

export type RuntimeFormFactor = "phone" | "tablet";
export type RuntimeFitStatus = "fit" | "needs-editing" | "scrollable";

export interface RuntimeFit {
  readonly formFactor: RuntimeFormFactor;
  readonly status: RuntimeFitStatus;
  readonly columnCount: 1 | 2;
  readonly bodyPx: number;
  readonly lineHeight: number;
  /** The first section rendered in the right column, or null for phone. */
  readonly split: number | null;
}

export type RuntimeFitResult = RuntimeFit;

export type ApexSourceNode = HTMLElement | DocumentFragment;

export interface RuntimeFitTarget {
  /** The inert, verified Apex HTML source. It is read-only to this module. */
  readonly source: ApexSourceNode;
  /** The element whose client dimensions define the sheet's available space. */
  readonly viewport: HTMLElement;
  /** The sole persistent mutation target; normally `[data-live-columns]`. */
  readonly columns: HTMLElement;
}

export interface FormFactorViewport {
  readonly innerWidth: number;
  readonly navigator: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">;
  readonly visualViewport?: Pick<VisualViewport, "width"> | null;
}

export interface RuntimeFitOptions {
  /** A test/embedding override. Normal Live fitting always detects this per fit. */
  readonly formFactor?: RuntimeFormFactor;
  /** Allows an embedded document or deterministic test to provide its own viewport. */
  readonly view?: FormFactorViewport;
}

export interface LiveFitterObserverOptions extends RuntimeFitOptions {
  /** Defaults to the source document's documentElement, matching the v1 resize observer. */
  readonly resizeRoot?: Element;
  /** v1 batches geometry changes for 100ms. Set to zero for deterministic tests. */
  readonly debounceMs?: number;
}

export interface LiveFitterObserver {
  /** Refit now. Each fit redetects the form factor unless an explicit override was supplied. */
  readonly refit: () => Promise<readonly RuntimeFit[]>;
  /** Removes resize, visual-viewport, orientation, and ResizeObserver listeners. */
  readonly disconnect: () => void;
}

export const TABLET_FONT_SIZES = Object.freeze([21, 20, 19, 18, 17, 16] as const);
export const TABLET_LINE_HEIGHTS = Object.freeze([1.24, 1.20, 1.16, 1.12] as const);
export const PHONE_TYPOGRAPHY = Object.freeze({ bodyPx: 20, lineHeight: 1.24 });
const OVERFLOW_TOLERANCE_PX = 1;

type FlowNode = Element | ColumnBreakMarker;
type Section = HTMLElement | ColumnBreakMarker;
type ColumnBreakMarker = HTMLSpanElement & { __songsColumnBreak: true };

function globalView(): FormFactorViewport {
  if (typeof window !== "undefined") return window;
  throw new Error("The Live fitter requires a browser viewport");
}

function isColumnBreak(node: Node | null | undefined): node is ColumnBreakMarker {
  return (node as ColumnBreakMarker | null | undefined)?.__songsColumnBreak === true;
}

/** Exact v1 form-factor rules, including iPadOS Safari's MacIntel UA. */
export function detectFormFactor(view: FormFactorViewport = globalView()): RuntimeFormFactor {
  const userAgent = view.navigator.userAgent;
  if (/iPhone|iPod/i.test(userAgent)) return "phone";
  const ipad = /iPad/i.test(userAgent) || (view.navigator.platform === "MacIntel" && view.navigator.maxTouchPoints > 1);
  const width = view.visualViewport?.width || view.innerWidth;
  if (ipad || (view.navigator.maxTouchPoints > 0 && width >= 768)) return "tablet";
  return width < 768 ? "phone" : "tablet";
}

const ALLOWED_PRESENTATION_ELEMENTS = new Set(["A", "BR", "CODE", "EM", "H1", "H2", "H3", "LI", "OL", "P", "SECTION", "SPAN", "STRONG", "SUB", "SUP", "UL"]);
const ALLOWED_PRESENTATION_CLASSES = new Set(["apex-upper-alpha", "measure-count", "section-block"]);

function sanitizePresentationElement(element: Element): Node {
  const owner = documentFor(element);
  if (!ALLOWED_PRESENTATION_ELEMENTS.has(element.tagName)) return owner.createTextNode(element.textContent ?? "");
  const classes = [...element.classList].filter((name) => ALLOWED_PRESENTATION_CLASSES.has(name));
  const upperAlpha = element.tagName === "OL" && element instanceof HTMLElement && element.style.listStyleType === "upper-alpha";
  for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
  if (upperAlpha) classes.push("apex-upper-alpha");
  if (classes.length > 0) element.className = [...new Set(classes)].join(" ");
  if (element.tagName === "A") {
    element.setAttribute("aria-disabled", "true");
    (element as HTMLElement).tabIndex = -1;
  }
  return element;
}

/** Clone verified Apex through a strict allowlist before it reaches the live DOM. */
export function cloneApexPresentationNode(node: Node): Node {
  if (isColumnBreak(node)) {
    const marker = documentFor(node).createElement("span") as ColumnBreakMarker;
    marker.__songsColumnBreak = true;
    marker.hidden = true;
    return marker;
  }
  const clone = node.cloneNode(true);
  if (clone.nodeType !== Node.ELEMENT_NODE) return clone;
  const root = clone as Element;
  for (const descendant of [...root.querySelectorAll("*")].reverse()) {
    const sanitized = sanitizePresentationElement(descendant);
    if (sanitized !== descendant) descendant.replaceWith(sanitized);
  }
  return sanitizePresentationElement(root);
}

/**
 * Expands only the top-level Apex flow nodes. H1 is presentation chrome, not
 * lead-sheet content. A paragraph with at least ten BRs is split after each
 * eighth BR exactly as the v1 fitter did.
 */
export function expandFlowNodes(source: ApexSourceNode): readonly FlowNode[] {
  const expanded: FlowNode[] = [];
  for (const node of source.childNodes) {
    if (node.nodeType === Node.COMMENT_NODE && node.nodeValue?.trim().toLowerCase() === "column-break") {
      const marker = documentFor(source).createElement("span") as ColumnBreakMarker;
      marker.__songsColumnBreak = true;
      marker.hidden = true;
      expanded.push(marker);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    if (element.tagName === "H1") continue;
    if (element.tagName !== "P" || element.querySelectorAll("br").length < 10) {
      expanded.push(element);
      continue;
    }
    let paragraph = documentFor(source).createElement("p");
    let breaks = 0;
    for (const child of element.childNodes) {
      paragraph.append(cloneApexPresentationNode(child));
      if (child.nodeName === "BR") breaks += 1;
      if (breaks >= 8) {
        expanded.push(paragraph);
        paragraph = documentFor(source).createElement("p");
        breaks = 0;
      }
    }
    if (paragraph.childNodes.length) expanded.push(paragraph);
  }
  return expanded;
}

/** Adds the v1 measure-count badge while preserving the Apex heading element. */
export function cloneSectionHeading(node: Element): Element {
  const heading = node.cloneNode(false) as Element;
  const text = node.textContent?.trim() ?? "";
  const measure = /\b\d+\s*[xX](?:\s*\+\s*\d+)?\b/g;
  let cursor = 0;
  for (const match of text.matchAll(measure)) {
    heading.append(documentFor(node).createTextNode(text.slice(cursor, match.index)));
    const count = documentFor(node).createElement("span");
    count.className = "measure-count";
    count.textContent = match[0].replace(/\s*[xX]\s*/, "x").replace(/\s*\+\s*/, "+");
    heading.append(count);
    cursor = (match.index ?? 0) + match[0].length;
  }
  heading.append(documentFor(node).createTextNode(text.slice(cursor)));
  return heading;
}

/**
 * H2/H3 form a non-splittable group with the next flow node. This intentionally
 * preserves the v1 one-node grouping rule rather than attempting semantic
 * paragraph inference.
 */
export function sectionizeApex(source: ApexSourceNode): readonly Section[] {
  const nodes = expandFlowNodes(source);
  const sections: Section[] = [];
  let headingGroup: HTMLElement | null = null;
  const push = (section: Section): void => {
    section.dataset.sectionIndex = String(sections.length);
    sections.push(section);
  };

  for (const node of nodes) {
    if (isColumnBreak(node)) {
      if (headingGroup !== null) {
        push(headingGroup);
        headingGroup = null;
      }
      push(node);
      continue;
    }
    if (/^H[23]$/.test(node.tagName)) {
      if (headingGroup !== null) push(headingGroup);
      headingGroup = documentFor(source).createElement("section");
      headingGroup.className = "section-block";
      headingGroup.append(cloneSectionHeading(node));
      continue;
    }
    if (headingGroup !== null) {
      headingGroup.append(cloneApexPresentationNode(node));
      push(headingGroup);
      headingGroup = null;
      continue;
    }
    const section = documentFor(source).createElement("section");
    section.className = "section-block";
    section.append(cloneApexPresentationNode(node));
    push(section);
  }
  if (headingGroup !== null) push(headingGroup);
  if (sections.length > 0) return sections;
  const section = documentFor(source).createElement("section");
  section.className = "section-block";
  section.dataset.sectionIndex = "0";
  return [section];
}

/** The v1 least-delta prefix split; ties intentionally retain the earlier split. */
export function bestBalancedSplit(heights: readonly number[]): number {
  if (heights.length <= 1) return 1;
  const total = heights.reduce((sum, height) => sum + height, 0);
  let sum = 0;
  let best = 1;
  let delta = Infinity;
  for (let index = 1; index < heights.length; index += 1) {
    sum += heights[index - 1] as number;
    const nextDelta = Math.abs(sum - (total - sum));
    if (nextDelta < delta) {
      delta = nextDelta;
      best = index;
    }
  }
  return best;
}

/** Returns the v1 explicit break split, or zero when the comment is ineligible. */
export function forcedColumnSplit(sections: readonly Section[]): number {
  for (let split = 1; split < sections.length - 1; split += 1) {
    if (
      isColumnBreak(sections[split])
      && sections.slice(0, split).some((section) => !isColumnBreak(section))
      && sections.slice(split + 1).some((section) => !isColumnBreak(section))
    ) return split;
  }
  return 0;
}

function documentFor(node: Node): Document {
  return node.ownerDocument ?? document;
}

function applyTypography(columns: HTMLElement, bodyPx: number, lineHeight: number): void {
  columns.style.setProperty("--sheet-font", `${bodyPx}px`);
  columns.style.setProperty("--sheet-line", String(lineHeight));
}

function makeColumn(source: ApexSourceNode): HTMLDivElement {
  const column = documentFor(source).createElement("div");
  column.className = "live-column";
  return column;
}

function renderColumns(container: HTMLElement, sections: readonly Section[], count: 1 | 2, split: number): readonly HTMLDivElement[] {
  container.replaceChildren();
  if (count === 1) {
    const column = makeColumn(container);
    for (const section of sections) if (!isColumnBreak(section)) column.append(cloneApexPresentationNode(section));
    container.append(column);
    return [column];
  }
  const left = makeColumn(container);
  const right = makeColumn(container);
  sections.forEach((section, index) => {
    if (!isColumnBreak(section)) (index < split ? left : right).append(cloneApexPresentationNode(section));
  });
  container.append(left, right);
  return [left, right];
}

function measureSections(target: RuntimeFitTarget, sections: readonly Section[], width: number, bodyPx: number, lineHeight: number): readonly number[] {
  const host = documentFor(target.columns).createElement("div");
  host.className = "measure-host locked-live-columns";
  host.style.display = "block";
  host.style.width = `${Math.max(1, width)}px`;
  host.style.height = "auto";
  applyTypography(host, bodyPx, lineHeight);
  for (const section of sections) host.append(cloneApexPresentationNode(section));
  // The temporary host remains within the sole allowed mutation subtree.
  target.columns.append(host);
  try {
    return [...host.children].map((element) => Math.ceil(element.getBoundingClientRect().height));
  } finally {
    host.remove();
  }
}

function horizontalSafe(element: HTMLElement): boolean {
  return element.scrollWidth <= element.clientWidth + OVERFLOW_TOLERANCE_PX;
}

function verticalSafe(element: HTMLElement): boolean {
  return element.scrollHeight <= element.clientHeight + OVERFLOW_TOLERANCE_PX;
}

function gapFor(columns: HTMLElement): number {
  const view = columns.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(columns);
  return Number.parseFloat(computed?.columnGap || computed?.gap || "") || 24;
}

async function waitForFonts(node: Node): Promise<void> {
  const fontDocument = documentFor(node) as Document & { readonly fonts?: { readonly ready: Promise<unknown> } };
  await (fontDocument.fonts?.ready ?? Promise.resolve());
}

/**
 * Fits one verified Apex lead sheet. Apart from temporary measurement content,
 * all mutation is confined to `target.columns`; state is reported explicitly
 * in the returned RuntimeFit rather than in panel data attributes.
 */
export async function fitLiveLeadSheet(target: RuntimeFitTarget, options: RuntimeFitOptions = {}): Promise<RuntimeFit> {
  const sections = sectionizeApex(target.source);
  const formFactor = options.formFactor ?? detectFormFactor(options.view ?? (target.source.ownerDocument.defaultView ?? globalView()));
  await waitForFonts(target.columns);

  if (formFactor === "phone") {
    applyTypography(target.columns, PHONE_TYPOGRAPHY.bodyPx, PHONE_TYPOGRAPHY.lineHeight);
    const column = renderColumns(target.columns, sections, 1, sections.length)[0] as HTMLDivElement;
    return {
      formFactor,
      status: horizontalSafe(column) && horizontalSafe(target.columns) ? "scrollable" : "needs-editing",
      columnCount: 1,
      bodyPx: PHONE_TYPOGRAPHY.bodyPx,
      lineHeight: PHONE_TYPOGRAPHY.lineHeight,
      split: null,
    };
  }

  const gap = gapFor(target.columns);
  const width = (target.viewport.clientWidth - gap) / 2;
  const height = target.viewport.clientHeight;
  const forcedSplit = forcedColumnSplit(sections);

  for (const bodyPx of TABLET_FONT_SIZES) {
    for (const lineHeight of TABLET_LINE_HEIGHTS) {
      applyTypography(target.columns, bodyPx, lineHeight);
      const heights = measureSections(target, sections, width, bodyPx, lineHeight);
      const split = forcedSplit || bestBalancedSplit(heights);
      const leftHeight = heights.slice(0, split).reduce((sum, value) => sum + value, 0);
      const rightHeight = heights.slice(split).reduce((sum, value) => sum + value, 0);
      const columns = renderColumns(target.columns, sections, 2, split);
      const fits = leftHeight <= height + OVERFLOW_TOLERANCE_PX
        && rightHeight <= height + OVERFLOW_TOLERANCE_PX
        && columns.every((column) => horizontalSafe(column) && verticalSafe(column))
        && horizontalSafe(target.columns);
      if (fits) {
        return { formFactor, status: "fit", columnCount: 2, bodyPx, lineHeight, split };
      }
    }
  }

  applyTypography(target.columns, 16, 1.12);
  const floorHeights = measureSections(target, sections, width, 16, 1.12);
  const floorSplit = forcedSplit || bestBalancedSplit(floorHeights);
  renderColumns(target.columns, sections, 2, floorSplit);
  return { formFactor, status: "needs-editing", columnCount: 2, bodyPx: 16, lineHeight: 1.12, split: floorSplit };
}

/** Finds the three Live nodes below a panel without mutating that panel. */
export function liveFitTargetFor(panel: HTMLElement): RuntimeFitTarget | null {
  const sourceElement = panel.querySelector<HTMLElement>("[data-apex-source]");
  const source = sourceElement instanceof HTMLTemplateElement ? sourceElement.content : sourceElement;
  const viewport = panel.querySelector<HTMLElement>("[data-sheet-viewport]");
  const columns = panel.querySelector<HTMLElement>("[data-live-columns]");
  return source === null || viewport === null || columns === null ? null : { source, viewport, columns };
}

/** v1-compatible panel helper. A panel lacking Live nodes is intentionally a no-op. */
export async function fitSheet(panel: HTMLElement, options: RuntimeFitOptions = {}): Promise<RuntimeFit | null> {
  const target = liveFitTargetFor(panel);
  return target === null ? null : fitLiveLeadSheet(target, options);
}

function targetsFrom(source: Iterable<RuntimeFitTarget> | (() => Iterable<RuntimeFitTarget>)): readonly RuntimeFitTarget[] {
  return [...(typeof source === "function" ? source() : source)];
}

/**
 * Refit a changing Live surface on the same geometry signals used by v1.
 * Calling disconnect is required when the Live route unmounts.
 */
export function observeLiveLeadSheets(
  source: Iterable<RuntimeFitTarget> | (() => Iterable<RuntimeFitTarget>),
  options: LiveFitterObserverOptions = {},
): LiveFitterObserver {
  const initialTargets = targetsFrom(source);
  const documentRoot = initialTargets[0]?.source.ownerDocument.documentElement;
  const eventView = (options.view ?? initialTargets[0]?.source.ownerDocument.defaultView ?? globalView()) as FormFactorViewport & EventTarget & {
    readonly visualViewport?: (Pick<VisualViewport, "width" | "addEventListener" | "removeEventListener"> & EventTarget) | null;
    readonly setTimeout?: typeof setTimeout;
    readonly clearTimeout?: typeof clearTimeout;
  };
  const timeout = eventView.setTimeout?.bind(eventView) ?? setTimeout;
  const clear = eventView.clearTimeout?.bind(eventView) ?? clearTimeout;
  const debounceMs = options.debounceMs ?? 100;
  let disconnected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fitting: Promise<readonly RuntimeFit[]> | null = null;

  const refit = (): Promise<readonly RuntimeFit[]> => {
    if (disconnected) return Promise.resolve([]);
    if (fitting !== null) return fitting;
    fitting = Promise.all(targetsFrom(source).map((target) => fitLiveLeadSheet(target, options))).finally(() => { fitting = null; });
    return fitting;
  };
  const schedule = (): void => {
    if (disconnected) return;
    if (timer !== undefined) clear(timer);
    timer = timeout(() => {
      timer = undefined;
      void refit();
    }, debounceMs);
  };

  eventView.addEventListener("resize", schedule);
  eventView.visualViewport?.addEventListener("resize", schedule);
  eventView.addEventListener("orientationchange", schedule);

  const ResizeObserverConstructor = typeof ResizeObserver === "undefined" ? undefined : ResizeObserver;
  const resizeObserver = ResizeObserverConstructor === undefined ? null : new ResizeObserverConstructor(schedule);
  const resizeRoot = options.resizeRoot ?? documentRoot;
  if (resizeObserver !== null && resizeRoot !== undefined) resizeObserver.observe(resizeRoot);

  return {
    refit,
    disconnect: () => {
      if (disconnected) return;
      disconnected = true;
      if (timer !== undefined) clear(timer);
      eventView.removeEventListener("resize", schedule);
      eventView.visualViewport?.removeEventListener("resize", schedule);
      eventView.removeEventListener("orientationchange", schedule);
      resizeObserver?.disconnect();
    },
  };
}

/** A more descriptive alias for callers that prefer a runtime-oriented name. */
export const observeRuntimeFit = observeLiveLeadSheets;
