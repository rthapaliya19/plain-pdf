/**
 * The Redact tool (in the More menu): drag a box over anything you want
 * removed: words, pictures, part of a scan. The box shows as solid black;
 * when a copy is saved, everything under it is removed from the file for
 * good (see save/redact.ts). Boxes can be moved, resized and removed like
 * signatures, and every change can be undone.
 *
 * On phones one finger draws a box; two fingers scroll and zoom.
 */
import { newAdditionMeta, type Additions, type Redaction } from "../../core/additions";
import type { History } from "../../core/history";
import type { Tool } from "../../core/tools";
import type { OverlayRenderer } from "../../overlay/overlay-renderer";
import { icons } from "../../ui/icons";
import { showToast } from "../../ui/toast";
import type { Viewer } from "../../viewer/viewer";

/** Boxes smaller than this (points) are taken as a stray tap. */
const MIN_SIZE = 4;
const HINT_KEY = "plain-pdf:redact-hint-shown";

interface Press {
  pointerId: number;
  page: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export class RedactTool implements Tool {
  readonly id = "redact";
  readonly options: HTMLDivElement;
  private active = false;
  private press: Press | null = null;
  private touches = new Set<number>();
  private preview: HTMLDivElement | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    private readonly history: History,
    private readonly renderer: OverlayRenderer,
    onDone: () => void,
  ) {
    this.options = document.createElement("div");
    this.options.className = "draw-options redact-options";
    this.options.setAttribute("role", "toolbar");
    this.options.setAttribute("aria-label", "Redact");
    this.options.hidden = true;
    const label = document.createElement("span");
    label.className = "redact-label";
    label.textContent = "Drag over what to remove";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "done-button";
    done.title = "Stop redacting (Esc)";
    done.innerHTML = icons.check;
    done.append("Done");
    done.addEventListener("click", () => onDone());
    const group = document.createElement("div");
    group.className = "option-group";
    group.append(done);
    this.options.append(label, group);

    const el = viewer.element;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", (e) => this.onUp(e, true));
  }

  activate(): void {
    this.active = true;
    this.viewer.setRedactMode(true);
    this.options.hidden = false;
    let shown = false;
    try {
      shown = localStorage.getItem(HINT_KEY) === "1";
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      // Storage unavailable: show the hint each time.
    }
    if (!shown) {
      showToast("Drag a box over anything you want removed. When you save a copy, everything under the black boxes is removed for good. The original file isn't changed.", 9000);
    }
  }

  deactivate(): void {
    this.active = false;
    this.press = null;
    this.touches.clear();
    this.clearPreview();
    this.viewer.setRedactMode(false);
    this.options.hidden = true;
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.pointerType === "touch") {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // A second finger: this is a scroll or zoom, not a box.
        this.press = null;
        this.clearPreview();
        return;
      }
    }
    // Existing boxes (and signatures, text) are moved and resized by the selection controller.
    if ((e.target as HTMLElement).closest(".sig-box")) return;
    const page = this.viewer.pageIndexAt(e.clientX, e.clientY);
    if (page === null) return;
    e.preventDefault();
    this.renderer.select(null);
    const p = this.viewer.toPagePoint(page, e.clientX, e.clientY);
    this.press = { pointerId: e.pointerId, page, start: p, end: p };
    this.viewer.element.setPointerCapture?.(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.pointerId) return;
    pr.end = this.viewer.toPagePoint(pr.page, e.clientX, e.clientY);
    this.showPreview(pr.page, this.boxOf(pr));
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    if (e.pointerType === "touch") this.touches.delete(e.pointerId);
    const pr = this.press;
    if (!pr || e.pointerId !== pr.pointerId) return;
    this.press = null;
    this.clearPreview();
    if (cancelled) return;
    pr.end = this.viewer.toPagePoint(pr.page, e.clientX, e.clientY);
    const box = this.boxOf(pr);
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) return;
    const item: Redaction = { ...newAdditionMeta(), kind: "redact", page: pr.page, x: box.x, y: box.y, width: box.w, height: box.h };
    this.additions.add(item);
    this.history.record({
      undo: () => this.additions.remove(item),
      redo: () => this.additions.add(item),
    });
  }

  /** The dragged box, kept within the page. */
  private boxOf(pr: Press): { x: number; y: number; w: number; h: number } {
    const size = this.viewer.pageSize(pr.page);
    const clampX = (v: number) => Math.min(Math.max(v, 0), size.width);
    const clampY = (v: number) => Math.min(Math.max(v, 0), size.height);
    const x0 = clampX(Math.min(pr.start.x, pr.end.x));
    const x1 = clampX(Math.max(pr.start.x, pr.end.x));
    const y0 = clampY(Math.min(pr.start.y, pr.end.y));
    const y1 = clampY(Math.max(pr.start.y, pr.end.y));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private showPreview(page: number, r: { x: number; y: number; w: number; h: number }): void {
    const overlay = this.viewer.overlay(page);
    if (!overlay) return;
    if (!this.preview || this.preview.parentElement !== overlay) {
      this.clearPreview();
      this.preview = document.createElement("div");
      this.preview.className = "redact-preview";
      overlay.append(this.preview);
    }
    const size = this.viewer.pageSize(page);
    this.preview.style.left = `${(r.x / size.width) * 100}%`;
    this.preview.style.top = `${(r.y / size.height) * 100}%`;
    this.preview.style.width = `${(r.w / size.width) * 100}%`;
    this.preview.style.height = `${(r.h / size.height) * 100}%`;
  }

  private clearPreview(): void {
    this.preview?.remove();
    this.preview = null;
  }
}
