/**
 * The Draw tool: pen, highlighter and eraser.
 *
 * - Mouse, trackpad, stylus or one finger draws.
 * - The highlighter follows the text: a drag that starts on text highlights
 *   exactly the words it covers, line by line, like selecting text. Where
 *   there is no text the app can read (for example a scanned page, which is
 *   just a picture), it draws a straight line instead, snapping level when
 *   the drag is close to horizontal.
 * - On touch screens, putting a second finger down cancels the line just
 *   started (so two-finger scrolling and pinching don't leave marks).
 * - The eraser removes whole pen strokes and highlights it touches. It never
 *   touches signatures (those have their own remove button) or the PDF.
 */
import {
  newAdditionMeta,
  type Addition,
  type Additions,
  type Stroke,
  type TextHighlight,
} from "../../core/additions";
import type { History } from "../../core/history";
import { highlightRects, lineAt, type Rect, type TextLayoutCache, type TextLine } from "../../core/text-layout";
import type { Tool } from "../../core/tools";
import { hitsStroke } from "../../overlay/paths";
import type { OverlayRenderer } from "../../overlay/overlay-renderer";
import type { Viewer } from "../../viewer/viewer";
import { DrawOptions } from "./draw-options";
import {
  HIGHLIGHTER_COLOR,
  HIGHLIGHTER_LINE_WIDTH,
  PEN_SIZES,
  loadSettings,
  saveSettings,
  type DrawSettings,
} from "./settings";

/** A line started this recently is dropped if a second finger lands (it was meant as a scroll). */
const SECOND_FINGER_GRACE_MS = 300;
/** Ignore pointer movement smaller than this, in screen pixels. */
const MIN_STEP_PX = 0.75;
/** Eraser reach around the pointer, in screen pixels. */
const ERASER_RADIUS_PX = 10;
/** Straight highlighter lines within this angle of level snap to perfectly level. */
const LEVEL_SNAP_DEGREES = 12;

type Point = { x: number; y: number };

interface PenDrawing {
  kind: "pen";
  pointerId: number;
  startedAt: number;
  stroke: Stroke;
  path: SVGPathElement;
  frame: number;
}

interface Highlighting {
  kind: "highlight";
  pointerId: number;
  startedAt: number;
  page: number;
  start: Point;
  end: Point;
  /** "text" once we know the drag started on text; "straight" otherwise. */
  mode: "text" | "straight";
  /** True once the page's text has been checked. */
  textChecked: boolean;
  lines: TextLine[];
  line: TextLine | null;
  rects: Rect[];
  liveRects: SVGGElement | null;
  stroke: Stroke;
  path: SVGPathElement | null;
  frame: number;
}

interface Erasing {
  kind: "erase";
  pointerId: number;
  removed: Addition[];
}

type Gesture = PenDrawing | Highlighting | Erasing;

export class DrawTool implements Tool {
  readonly id = "draw";
  readonly options: DrawOptions;
  private settings: DrawSettings = loadSettings();
  private active = false;
  private gesture: Gesture | null = null;
  private touches = new Set<number>();
  /** After a multi-finger gesture, wait until every finger is lifted before drawing again. */
  private waitForAllFingersUp = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    private readonly history: History,
    private readonly overlay: OverlayRenderer,
    private readonly textLayout: () => TextLayoutCache | null,
    onDone: () => void,
  ) {
    this.options = new DrawOptions(
      this.settings,
      (settings) => {
        this.settings = settings;
        saveSettings(settings);
        if (this.active) {
          this.viewer.setDrawingMode(settings.mode === "eraser" ? "eraser" : "pen");
          if (settings.mode === "highlighter") this.prefetchText();
        }
      },
      onDone,
    );

    const el = viewer.element;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e, false));
    el.addEventListener("pointercancel", (e) => this.onUp(e, true));
  }

  activate(): void {
    this.active = true;
    this.options.show();
    this.viewer.setDrawingMode(this.settings.mode === "eraser" ? "eraser" : "pen");
    if (this.settings.mode === "highlighter") this.prefetchText();
  }

  deactivate(): void {
    this.finish(false);
    this.active = false;
    this.options.hide();
    this.viewer.setDrawingMode(null);
  }

  /** Works out the text on nearby pages ahead of time, so highlights snap instantly. */
  private prefetchText(): void {
    const cache = this.textLayout();
    if (!cache) return;
    const current = this.viewer.currentPageIndex;
    for (const page of [current, current + 1, current - 1]) {
      if (page >= 0 && page < this.viewer.pageCount) void cache.load(page);
    }
  }

  // ---------- Pointer handling ----------

  private onDown(e: PointerEvent): void {
    if (!this.active) return;
    if (e.pointerType === "touch") {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // Two or more fingers: the person wants to scroll or zoom.
        this.waitForAllFingersUp = true;
        const g = this.gesture;
        const young = g && g.kind !== "erase" && performance.now() - g.startedAt < SECOND_FINGER_GRACE_MS;
        this.finish(!young);
        return;
      }
      if (this.waitForAllFingersUp) return;
    } else if (e.button !== 0) {
      return;
    }
    if (this.gesture) return;

    const page = this.viewer.pageIndexAt(e.clientX, e.clientY);
    if (page === null) return;
    e.preventDefault();
    this.viewer.element.setPointerCapture(e.pointerId);
    const point = this.viewer.toPagePoint(page, e.clientX, e.clientY);

    if (this.settings.mode === "eraser") {
      this.gesture = { kind: "erase", pointerId: e.pointerId, removed: [] };
      this.eraseAt(page, point.x, point.y);
    } else if (this.settings.mode === "highlighter") {
      this.startHighlight(e.pointerId, page, point);
    } else {
      const stroke: Stroke = {
        kind: "stroke",
        ...newAdditionMeta(),
        page,
        tool: "pen",
        color: this.settings.penColor,
        width: PEN_SIZES[this.settings.size],
        points: [point.x, point.y],
      };
      this.gesture = {
        kind: "pen",
        pointerId: e.pointerId,
        startedAt: performance.now(),
        stroke,
        path: this.overlay.beginLive(stroke),
        frame: 0,
      };
    }
  }

  private onMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples = events.length > 0 ? events : [e];

    if (g.kind === "pen") {
      const minStep = MIN_STEP_PX / this.viewer.cssPixelsPerPoint;
      const pts = g.stroke.points;
      for (const s of samples) {
        const p = this.viewer.toPagePoint(g.stroke.page, s.clientX, s.clientY);
        if (Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]) >= minStep) pts.push(p.x, p.y);
      }
      if (!g.frame) {
        g.frame = requestAnimationFrame(() => {
          g.frame = 0;
          this.overlay.updateLive(g.path, g.stroke);
        });
      }
    } else if (g.kind === "highlight") {
      g.end = this.viewer.toPagePoint(g.page, e.clientX, e.clientY);
      if (!g.frame) {
        g.frame = requestAnimationFrame(() => {
          g.frame = 0;
          this.updateHighlight(g);
        });
      }
    } else {
      for (const s of samples) {
        const page = this.viewer.pageIndexAt(s.clientX, s.clientY);
        if (page === null) continue;
        const p = this.viewer.toPagePoint(page, s.clientX, s.clientY);
        this.eraseAt(page, p.x, p.y);
      }
    }
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.touches.size === 0) this.waitForAllFingersUp = false;
    }
    if (this.gesture?.pointerId === e.pointerId) this.finish(!cancelled);
  }

  /** Ends the current gesture, keeping the result (with undo) or throwing it away. */
  private finish(keep: boolean): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.kind === "pen") {
      cancelAnimationFrame(g.frame);
      this.overlay.endLive(g.path);
      if (keep) this.commit(roundPoints(g.stroke));
    } else if (g.kind === "highlight") {
      cancelAnimationFrame(g.frame);
      const cache = this.textLayout();
      if (keep && !g.textChecked && cache) {
        // A very quick swipe can finish before the page's text is ready.
        // Wait for it (a few milliseconds) so the highlight still snaps.
        void cache.load(g.page).then((lines) => {
          // Skip if a different file was opened in the meantime.
          if (this.textLayout() !== cache) return this.completeHighlight(g, false);
          this.decideHighlightMode(g, lines);
          this.completeHighlight(g, true);
        });
        return;
      }
      this.completeHighlight(g, keep);
    } else if (g.removed.length > 0) {
      const removed = g.removed;
      this.history.record({
        undo: () => this.additions.add(...removed),
        redo: () => this.additions.remove(...removed),
      });
    }
  }

  private completeHighlight(g: Highlighting, keep: boolean): void {
    if (keep) this.updateHighlight(g);
    if (g.liveRects) this.overlay.endLive(g.liveRects);
    if (g.path) this.overlay.endLive(g.path);
    if (!keep) return;
    if (g.mode === "text" && g.rects.length > 0) {
      const highlight: TextHighlight = {
        kind: "highlight",
        ...newAdditionMeta(),
        page: g.page,
        color: HIGHLIGHTER_COLOR,
        rects: g.rects.map(roundRect),
      };
      this.commit(highlight);
    } else if (g.mode === "straight" && Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) > 2) {
      this.commit(roundPoints(g.stroke));
    }
  }

  private commit(item: Addition): void {
    this.additions.add(item);
    this.history.record({
      undo: () => this.additions.remove(item),
      redo: () => this.additions.add(item),
    });
  }

  // ---------- Highlighter ----------

  private startHighlight(pointerId: number, page: number, start: Point): void {
    const g: Highlighting = {
      kind: "highlight",
      pointerId,
      startedAt: performance.now(),
      page,
      start,
      end: start,
      mode: "straight",
      textChecked: false,
      lines: [],
      line: null,
      rects: [],
      liveRects: null,
      stroke: {
        kind: "stroke",
        ...newAdditionMeta(),
        page,
        tool: "highlighter",
        color: HIGHLIGHTER_COLOR,
        width: HIGHLIGHTER_LINE_WIDTH,
        points: [start.x, start.y, start.x, start.y],
      },
      path: null,
      frame: 0,
    };
    this.gesture = g;

    const cache = this.textLayout();
    const known = cache?.peek(page);
    if (known || !cache) {
      this.decideHighlightMode(g, known ?? []);
    } else {
      // Usually ready within a few milliseconds. Until then, show a straight line.
      void cache.load(page).then((lines) => {
        if (this.gesture === g) {
          this.decideHighlightMode(g, lines);
          this.updateHighlight(g);
        }
      });
    }
    this.updateHighlight(g);
  }

  private decideHighlightMode(g: Highlighting, lines: TextLine[]): void {
    g.textChecked = true;
    const line = lineAt(lines, g.start.x, g.start.y);
    if (!line) return;
    g.mode = "text";
    g.lines = lines;
    g.line = line;
    if (g.path) {
      this.overlay.endLive(g.path);
      g.path = null;
    }
  }

  private updateHighlight(g: Highlighting): void {
    if (g.mode === "text" && g.line) {
      g.rects = highlightRects(g.lines, g.line, g.start, g.end);
      g.liveRects ??= this.overlay.beginLiveRects(g.page);
      this.overlay.updateLiveRects(g.liveRects, g.rects, HIGHLIGHTER_COLOR);
      return;
    }
    // Straight line, level if close to level.
    let { x, y } = g.end;
    const angle = (Math.atan2(y - g.start.y, x - g.start.x) * 180) / Math.PI;
    if (Math.abs(angle) < LEVEL_SNAP_DEGREES || Math.abs(Math.abs(angle) - 180) < LEVEL_SNAP_DEGREES) y = g.start.y;
    g.stroke.points = [g.start.x, g.start.y, x, y];
    if (!g.path) g.path = this.overlay.beginLive(g.stroke);
    this.overlay.updateLive(g.path, g.stroke);
  }

  // ---------- Eraser ----------

  private eraseAt(page: number, x: number, y: number): void {
    const g = this.gesture;
    if (!g || g.kind !== "erase") return;
    const reach = ERASER_RADIUS_PX / this.viewer.cssPixelsPerPoint;
    const hits = this.additions.onPage(page).filter((a) => {
      if (a.kind === "stroke") return hitsStroke(a.points, x, y, reach + a.width / 2);
      if (a.kind === "highlight") {
        return a.rects.some((r) => x >= r.x - reach && x <= r.x + r.w + reach && y >= r.y - reach && y <= r.y + r.h + reach);
      }
      return false; // Signatures are removed with their own × button.
    });
    if (hits.length === 0) return;
    this.additions.remove(...hits);
    g.removed.push(...hits);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

function roundPoints(stroke: Stroke): Stroke {
  return { ...stroke, points: stroke.points.map(round) };
}

function roundRect(r: Rect): Rect {
  return { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) };
}
