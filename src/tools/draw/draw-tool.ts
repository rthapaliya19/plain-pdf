/**
 * The Draw tool: pen, highlighter and eraser.
 *
 * - Mouse, trackpad, stylus or one finger draws.
 * - On touch screens, putting a second finger down cancels the line just
 *   started (so two-finger scrolling and pinching don't leave marks).
 * - The eraser removes whole strokes it touches. It can only remove things
 *   that were added; the original PDF is never changed.
 */
import { newAdditionMeta, type Additions, type Stroke } from "../../core/additions";
import type { History } from "../../core/history";
import type { Tool } from "../../core/tools";
import { hitsStroke } from "../../overlay/paths";
import type { OverlayRenderer } from "../../overlay/overlay-renderer";
import type { Viewer } from "../../viewer/viewer";
import { DrawOptions } from "./draw-options";
import { HIGHLIGHTER_COLOR, SIZES, loadSettings, saveSettings, type DrawSettings } from "./settings";

/** A line started this recently is dropped if a second finger lands (it was meant as a scroll). */
const SECOND_FINGER_GRACE_MS = 300;
/** Ignore pointer movement smaller than this, in screen pixels. */
const MIN_STEP_PX = 0.75;
/** Eraser reach around the pointer, in screen pixels. */
const ERASER_RADIUS_PX = 10;

interface Drawing {
  pointerId: number;
  stroke: Stroke;
  path: SVGPathElement;
  startedAt: number;
  frame: number;
}

interface Erasing {
  pointerId: number;
  removed: Stroke[];
}

export class DrawTool implements Tool {
  readonly id = "draw";
  readonly options: DrawOptions;
  private settings: DrawSettings = loadSettings();
  private active = false;
  private drawing: Drawing | null = null;
  private erasing: Erasing | null = null;
  private touches = new Set<number>();
  /** After a multi-finger gesture, wait until every finger is lifted before drawing again. */
  private waitForAllFingersUp = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    private readonly history: History,
    private readonly overlay: OverlayRenderer,
  ) {
    this.options = new DrawOptions(this.settings, (settings) => {
      this.settings = settings;
      saveSettings(settings);
      if (this.active) this.viewer.setDrawingMode(settings.mode === "eraser" ? "eraser" : "pen");
    });

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
  }

  deactivate(): void {
    this.finishDrawing(false);
    this.finishErasing();
    this.active = false;
    this.options.hide();
    this.viewer.setDrawingMode(null);
  }

  // ---------- Pointer handling ----------

  private onDown(e: PointerEvent): void {
    if (!this.active) return;
    if (e.pointerType === "touch") {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // Two or more fingers: the person wants to scroll or zoom.
        this.waitForAllFingersUp = true;
        const young = this.drawing && performance.now() - this.drawing.startedAt < SECOND_FINGER_GRACE_MS;
        this.finishDrawing(!young);
        this.finishErasing();
        return;
      }
      if (this.waitForAllFingersUp) return;
    } else if (e.button !== 0) {
      return;
    }
    if (this.drawing || this.erasing) return;

    const page = this.viewer.pageIndexAt(e.clientX, e.clientY);
    if (page === null) return;
    e.preventDefault();
    this.viewer.element.setPointerCapture(e.pointerId);
    const point = this.viewer.toPagePoint(page, e.clientX, e.clientY);

    if (this.settings.mode === "eraser") {
      this.erasing = { pointerId: e.pointerId, removed: [] };
      this.eraseAt(page, point.x, point.y);
      return;
    }

    const tool = this.settings.mode;
    const stroke: Stroke = {
      kind: "stroke",
      ...newAdditionMeta(),
      page,
      tool,
      color: tool === "highlighter" ? HIGHLIGHTER_COLOR : this.settings.penColor,
      width: SIZES[tool][this.settings.size],
      points: [point.x, point.y],
    };
    this.drawing = {
      pointerId: e.pointerId,
      stroke,
      path: this.overlay.beginLive(stroke),
      startedAt: performance.now(),
      frame: 0,
    };
  }

  private onMove(e: PointerEvent): void {
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples = events.length > 0 ? events : [e];

    if (this.drawing && e.pointerId === this.drawing.pointerId) {
      const d = this.drawing;
      const minStep = MIN_STEP_PX / this.viewer.cssPixelsPerPoint;
      const pts = d.stroke.points;
      for (const s of samples) {
        const p = this.viewer.toPagePoint(d.stroke.page, s.clientX, s.clientY);
        const lastX = pts[pts.length - 2];
        const lastY = pts[pts.length - 1];
        if (Math.hypot(p.x - lastX, p.y - lastY) >= minStep) pts.push(p.x, p.y);
      }
      if (!d.frame) {
        d.frame = requestAnimationFrame(() => {
          d.frame = 0;
          this.overlay.updateLive(d.path, d.stroke);
        });
      }
    } else if (this.erasing && e.pointerId === this.erasing.pointerId) {
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
    if (this.drawing?.pointerId === e.pointerId) this.finishDrawing(!cancelled);
    if (this.erasing?.pointerId === e.pointerId) this.finishErasing();
  }

  // ---------- Pen and highlighter ----------

  /** Ends the current line, keeping it (with undo) or throwing it away. */
  private finishDrawing(keep: boolean): void {
    const d = this.drawing;
    if (!d) return;
    this.drawing = null;
    cancelAnimationFrame(d.frame);
    this.overlay.endLive(d.path);
    if (!keep) return;
    const stroke = d.stroke;
    stroke.points = stroke.points.map((v) => Math.round(v * 100) / 100);
    this.additions.add(stroke);
    this.history.record({
      undo: () => this.additions.remove(stroke),
      redo: () => this.additions.add(stroke),
    });
  }

  // ---------- Eraser ----------

  private eraseAt(page: number, x: number, y: number): void {
    if (!this.erasing) return;
    const reach = ERASER_RADIUS_PX / this.viewer.cssPixelsPerPoint;
    const hits = this.additions
      .onPage(page)
      .filter((a): a is Stroke => a.kind === "stroke" && hitsStroke(a.points, x, y, reach + a.width / 2));
    if (hits.length === 0) return;
    this.additions.remove(...hits);
    this.erasing.removed.push(...hits);
  }

  private finishErasing(): void {
    const er = this.erasing;
    if (!er) return;
    this.erasing = null;
    if (er.removed.length === 0) return;
    const removed = er.removed;
    this.history.record({
      undo: () => this.additions.add(...removed),
      redo: () => this.additions.remove(...removed),
    });
  }
}
