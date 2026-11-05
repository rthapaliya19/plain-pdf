/**
 * The page viewer: lays out every page of the open document in a scrolling
 * column, draws only the pages near the screen (so big files stay fast and
 * light on memory), and handles zoom and the current page number.
 *
 * Each page also gets an empty "overlay" layer on top of the PDF drawing.
 * Later features (pen, highlighter, signature) draw into that layer.
 */
import type { EventHub } from "../core/events";
import type { PdfDocument, RenderJob } from "../core/pdf-engine";
import { attachZoomGestures } from "./gestures";
import { MAX_ZOOM, MIN_ZOOM, clampZoom as clamp, type ZoomAnchor } from "./zoom";

/** CSS pixels per PDF point at 100% zoom (PDF uses 72 points per inch, screens 96 px). */
const CSS_PER_POINT = 96 / 72;
/** Largest zoom "Fit" will pick on wide screens, so pages don't get huge. */
const MAX_FIT_ZOOM = 1.25;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
/** Pages drawn at the same time. */
const RENDER_CONCURRENCY = 2;

interface PageView {
  index: number;
  el: HTMLDivElement;
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedAt: number; // pixels-per-point the current canvas was drawn at, 0 = none
  job: RenderJob | null;
  near: boolean; // on or close to the screen
}

export class Viewer {
  /** The scrolling area. */
  readonly element: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private doc: PdfDocument | null = null;
  private pages: PageView[] = [];
  private zoom = 1;
  private fit = true;
  private currentPage = 1;
  private observer: IntersectionObserver | null = null;
  private renderTimer = 0;
  private scrollFrame = 0;
  private activeJobs = 0;

  constructor(private readonly hub: EventHub) {
    this.element = document.createElement("div");
    this.element.className = "viewer";
    this.element.tabIndex = -1;
    this.pagesEl = document.createElement("div");
    this.pagesEl.className = "pages";
    this.element.append(this.pagesEl);

    this.element.addEventListener("scroll", () => this.onScroll(), { passive: true });
    new ResizeObserver(() => {
      if (!this.doc) return;
      if (this.fit) this.applyZoom(this.fitZoom(), null, true);
      this.layout();
    }).observe(this.element);

    attachZoomGestures(this.element, this.pagesEl, {
      getZoom: () => this.zoom,
      commit: (zoom, anchor, panX, panY) => {
        this.setZoom(zoom, anchor);
        this.element.scrollLeft -= panX;
        this.element.scrollTop -= panY;
      },
      enabled: () => this.doc !== null,
    });
  }

  get hasDocument(): boolean {
    return this.doc !== null;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Current on-screen size of one PDF point, in CSS pixels. */
  get cssPixelsPerPoint(): number {
    return this.zoom * CSS_PER_POINT;
  }

  // ---------- Helpers for tools that draw on pages ----------

  /** Size of page `index` (0-based) in PDF points. */
  pageSize(index: number): { width: number; height: number } {
    return this.doc!.pageSizes[index];
  }

  /** The layer on top of page `index` where additions are shown. */
  overlay(index: number): HTMLDivElement | null {
    return this.pages[index]?.overlay ?? null;
  }

  /** The page (0-based) under a point on screen, or null if there is none. */
  pageIndexAt(clientX: number, clientY: number): number | null {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".page");
    if (!hit || !this.pagesEl.contains(hit)) return null;
    return Number(hit.dataset.page) - 1;
  }

  /** Converts a point on screen to PDF points on page `index` (top-left origin). */
  toPagePoint(index: number, clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.pages[index].el.getBoundingClientRect();
    const size = this.doc!.pageSizes[index];
    return {
      x: ((clientX - rect.left) / rect.width) * size.width,
      y: ((clientY - rect.top) / rect.height) * size.height,
    };
  }

  /**
   * Switches between reading and drawing. While drawing, one finger (or the
   * mouse) draws instead of scrolling; two fingers still scroll and zoom.
   */
  setDrawingMode(mode: "pen" | "eraser" | null): void {
    this.element.classList.toggle("drawing", mode !== null);
    this.element.classList.toggle("erasing", mode === "eraser");
  }

  /** Shows a newly opened document, replacing any previous one. */
  show(doc: PdfDocument): void {
    this.clear();
    this.doc = doc;
    this.currentPage = 1;
    this.fit = true;
    this.zoom = this.fitZoom();

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.element,
      rootMargin: "150% 0px 150% 0px",
    });

    const fragment = document.createDocumentFragment();
    this.pages = doc.pageSizes.map((_, index) => {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.page = String(index + 1);
      el.setAttribute("aria-label", `Page ${index + 1}`);
      const overlay = document.createElement("div");
      overlay.className = "page-overlay";
      el.append(overlay);
      fragment.append(el);
      return { index, el, overlay, canvas: null, renderedAt: 0, job: null, near: false };
    });
    this.pagesEl.append(fragment);
    this.layout();
    for (const page of this.pages) this.observer.observe(page.el);

    this.element.scrollTop = 0;
    this.element.scrollLeft = 0;
    this.hub.emit("page:changed", { page: 1, pageCount: this.pages.length });
    this.hub.emit("zoom:changed", { zoom: this.zoom, fitWidth: this.fit });
    this.element.focus({ preventScroll: true });
  }

  /** Removes the current document from the screen. */
  clear(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const page of this.pages) page.job?.cancel();
    this.pages = [];
    this.pagesEl.replaceChildren();
    this.doc = null;
    this.activeJobs = 0;
  }

  // ---------- Zoom ----------

  zoomIn(anchor: ZoomAnchor | null = null): void {
    const next = ZOOM_STEPS.find((step) => step > this.zoom + 0.001) ?? MAX_ZOOM;
    this.setZoom(next, anchor);
  }

  zoomOut(anchor: ZoomAnchor | null = null): void {
    const next = [...ZOOM_STEPS].reverse().find((step) => step < this.zoom - 0.001) ?? MIN_ZOOM;
    this.setZoom(next, anchor);
  }

  /** Fits the page width to the window (up to a comfortable maximum). */
  fitToWidth(): void {
    if (!this.doc) return;
    this.applyZoom(this.fitZoom(), null, true);
  }

  setZoom(zoom: number, anchor: ZoomAnchor | null = null): void {
    this.applyZoom(zoom, anchor, false);
  }

  private fitZoom(): number {
    if (!this.doc) return 1;
    // Fit the page being read (like most PDF readers) rather than the widest
    // page, so one landscape page doesn't make all the other pages small.
    const width = this.doc.pageSizes[Math.min(this.currentPage, this.doc.pageCount) - 1].width;
    const styles = getComputedStyle(this.pagesEl);
    const padding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const available = Math.max(100, this.element.clientWidth - padding);
    return clamp(Math.min(available / (width * CSS_PER_POINT), MAX_FIT_ZOOM));
  }

  private applyZoom(zoom: number, anchor: ZoomAnchor | null, fit: boolean): void {
    if (!this.doc || this.pages.length === 0) return;
    zoom = clamp(zoom);
    const changed = Math.abs(zoom - this.zoom) > 0.0001;
    this.fit = fit;
    if (changed) {
      // Remember which spot of which page is under the anchor point...
      const rect = this.element.getBoundingClientRect();
      const ax = anchor ? anchor.clientX - rect.left : this.element.clientWidth / 2;
      const ay = anchor ? anchor.clientY - rect.top : this.element.clientHeight / 2;
      const contentX = this.element.scrollLeft + ax;
      const contentY = this.element.scrollTop + ay;
      const page = this.pageAt(contentY);
      const fx = (contentX - page.el.offsetLeft) / page.el.offsetWidth;
      const fy = (contentY - page.el.offsetTop) / page.el.offsetHeight;

      this.zoom = zoom;
      this.layout();

      // ...and keep that same spot under it after resizing.
      this.element.scrollLeft = page.el.offsetLeft + fx * page.el.offsetWidth - ax;
      this.element.scrollTop = page.el.offsetTop + fy * page.el.offsetHeight - ay;
      this.scheduleRender(150);
    }
    this.hub.emit("zoom:changed", { zoom: this.zoom, fitWidth: this.fit });
  }

  /** Sets every page's on-screen size for the current zoom. */
  private layout(): void {
    if (!this.doc) return;
    const scale = this.zoom * CSS_PER_POINT;
    let widest = 0;
    this.doc.pageSizes.forEach((size, i) => {
      const el = this.pages[i].el;
      const width = Math.round(size.width * scale);
      widest = Math.max(widest, width);
      el.style.width = `${width}px`;
      el.style.height = `${Math.round(size.height * scale)}px`;
    });
    // Pages are centred while they all fit across the window. Once any page
    // is wider than the window, line them up on the left instead, so the
    // narrower pages aren't pushed partly off screen.
    const styles = getComputedStyle(this.pagesEl);
    const padding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    this.pagesEl.classList.toggle("overflowing", widest + padding > this.element.clientWidth);
  }

  // ---------- Pages ----------

  /** Scrolls so that page `page` (1-based) is at the top. */
  goToPage(page: number): void {
    if (this.pages.length === 0) return;
    const target = this.pages[Math.min(Math.max(page, 1), this.pages.length) - 1];
    const gap = parseFloat(getComputedStyle(this.pagesEl).rowGap) || 0;
    this.element.scrollTop = target.el.offsetTop - gap;
    this.updateCurrentPage();
  }

  private pageAt(contentY: number): PageView {
    // Binary search: the last page whose top is above contentY.
    let low = 0;
    let high = this.pages.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.pages[mid].el.offsetTop <= contentY) low = mid;
      else high = mid - 1;
    }
    return this.pages[low];
  }

  private onScroll(): void {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.updateCurrentPage();
    });
  }

  private updateCurrentPage(): void {
    if (this.pages.length === 0) return;
    const el = this.element;
    // At the very bottom, the last page counts as current even if it's short.
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const page = atBottom
      ? this.pages.length
      : this.pageAt(el.scrollTop + el.clientHeight / 3).index + 1;
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.hub.emit("page:changed", { page, pageCount: this.pages.length });
    }
  }

  // ---------- Drawing pages ----------

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const page = this.pages[Number((entry.target as HTMLElement).dataset.page) - 1];
      if (!page) continue;
      page.near = entry.isIntersecting;
      if (!page.near) this.release(page);
    }
    this.scheduleRender(0);
  }

  private scheduleRender(delay: number): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.pump(), delay);
  }

  /** How many device pixels per PDF point to draw at, within memory limits. */
  private targetPixelsPerPoint(index: number): number {
    const size = this.doc!.pageSizes[index];
    const wanted = this.zoom * CSS_PER_POINT * (window.devicePixelRatio || 1);
    const coarse = matchMedia("(pointer: coarse)").matches;
    const maxPixels = coarse ? 8_000_000 : 16_000_000;
    const limit = Math.sqrt(maxPixels / (size.width * size.height));
    return Math.min(wanted, limit);
  }

  /** Starts drawing the pages that need it, nearest to the current page first. */
  private pump(): void {
    if (!this.doc) return;
    const needed = this.pages
      .filter((p) => p.near && !p.job && Math.abs(p.renderedAt - this.targetPixelsPerPoint(p.index)) > 0.001)
      .sort((a, b) => Math.abs(a.index + 1 - this.currentPage) - Math.abs(b.index + 1 - this.currentPage));
    for (const page of needed) {
      if (this.activeJobs >= RENDER_CONCURRENCY) break;
      this.render(page);
    }
  }

  private render(page: PageView): void {
    const doc = this.doc!;
    const pixelsPerPoint = this.targetPixelsPerPoint(page.index);
    // Draw into a fresh canvas and swap it in when done, so the old drawing
    // stays visible (just a little blurry) while the sharper one is made.
    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    const job = doc.renderPage(page.index, canvas, pixelsPerPoint);
    page.job = job;
    this.activeJobs++;
    job.promise
      .then(() => {
        if (this.doc !== doc || page.job !== job) return;
        if (page.canvas) page.canvas.replaceWith(canvas);
        else page.el.prepend(canvas);
        page.canvas = canvas;
        page.renderedAt = pixelsPerPoint;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "RenderingCancelledException") return;
        console.error(`Couldn't draw page ${page.index + 1}`, error);
        page.renderedAt = pixelsPerPoint; // don't retry endlessly
      })
      .finally(() => {
        if (page.job === job) page.job = null;
        if (this.doc === doc) {
          this.activeJobs--;
          this.pump();
        }
      });
  }

  /** Frees the memory of a page that has scrolled far away. */
  private release(page: PageView): void {
    if (page.job) {
      page.job.cancel();
      page.job = null;
    }
    if (page.canvas) {
      page.canvas.width = 0;
      page.canvas.height = 0;
      page.canvas.remove();
      page.canvas = null;
    }
    page.renderedAt = 0;
  }
}
