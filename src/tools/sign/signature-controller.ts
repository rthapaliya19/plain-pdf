/**
 * Placing, moving, resizing and removing signatures and initials.
 *
 * - The Sign button opens the Sign panel: tap your signature or initials to
 *   place it in the middle of the page you're looking at (an empty slot
 *   asks you to draw it first).
 * - Tap a signature to select it: drag it to move, drag the round corner
 *   handle to resize, tap × to remove it. Every change can be undone.
 */
import { newAdditionMeta, type Additions, type PlacedSignature, type SignatureInk, type TextBox } from "../../core/additions";
import type { EventHub } from "../../core/events";
import type { History } from "../../core/history";
import type { OverlayRenderer } from "../../overlay/overlay-renderer";
import { askConfirm } from "../../ui/dialog";
import { showToast } from "../../ui/toast";
import type { Viewer } from "../../viewer/viewer";
import { chooseFromSignPanel, drawInk } from "./signature-dialogs";
import { forgetInk, loadInk, saveInk, type InkKind } from "./signature-store";

/** Starting width of a placed signature, in points (about 2.5 inches). Initials start at a third of that. */
const DEFAULT_WIDTH: Record<InkKind, number> = { signature: 180, initials: 60 };
const MIN_WIDTH = 30;

/** Things you can select, drag and remove outside the tools: signatures, initials and text. */
type Movable = PlacedSignature | TextBox;

interface DragState {
  pointerId: number;
  mode: "move" | "resize";
  before: Movable;
  current: Movable;
  /** Was it already selected when pressed? (A second tap on text edits it.) */
  wasSelected: boolean;
  /** Pointer offset from the signature's top-left corner, in points (for moving). */
  offsetX: number;
  offsetY: number;
}

export class SignatureController {
  private drag: DragState | null = null;
  private busy = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    private readonly history: History,
    private readonly renderer: OverlayRenderer,
    hub: EventHub,
    /** Called to edit text (double-click, or tapping text that's already selected). */
    private readonly editText: (item: TextBox) => void,
  ) {
    const el = viewer.element;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", (e) => this.onUp(e));
    el.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>(".sig-delete");
      if (button) this.remove(button.closest<HTMLElement>(".sig-box")?.dataset.id ?? "");
    });
    el.addEventListener("dblclick", (e) => {
      const box = (e.target as HTMLElement).closest<HTMLElement>(".sig-box.text-box");
      const item = box ? this.additions.get(box.dataset.id ?? "") : undefined;
      if (item?.kind === "text") this.editText(item);
    });
    window.addEventListener("keydown", (e) => {
      const id = this.renderer.selectedSignature;
      if (!id || document.querySelector("dialog[open]")) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.remove(id);
      } else if (e.key === "Escape") {
        this.renderer.select(null);
      }
    });
    // Drawing tools and signatures don't mix: turning on Draw clears the selection.
    hub.on("tool:changed", ({ id }) => {
      if (id) this.renderer.select(null);
    });
    hub.on("additions:changed", () => {
      const id = this.renderer.selectedSignature;
      if (id && !this.additions.get(id)) this.renderer.select(null);
    });
  }

  /** What the Sign button does. */
  async start(): Promise<void> {
    if (this.busy || !this.viewer.hasDocument) return;
    this.busy = true;
    try {
      const choice = await chooseFromSignPanel({ signature: loadInk("signature"), initials: loadInk("initials") });
      if (!choice) return;
      const { kind, action } = choice;
      const name = kind === "signature" ? "signature" : "initials";
      if (action === "remove") {
        const sure = await askConfirm(
          `Remove your saved ${name}?`,
          `They will be deleted from this device. Any ${name} already placed on the page stay until you remove them.`,
          "Remove",
          "Keep",
        );
        if (sure) {
          forgetInk(kind);
          showToast(`Your ${name} ${kind === "signature" ? "was" : "were"} removed from this device.`);
        }
        return;
      }
      let ink = action === "place" ? loadInk(kind) : null;
      if (!ink) {
        ink = await drawInk(kind);
        if (!ink) return;
        if (!saveInk(kind, ink)) {
          showToast(`This browser won't let the app remember your ${name}, so they work until you close this page.`, 6000);
        }
      }
      this.place(ink, kind);
    } finally {
      this.busy = false;
    }
  }

  /** Puts the signature or initials in the middle of the part of the page you're looking at. */
  private place(ink: SignatureInk, role: InkKind): void {
    const rect = this.viewer.element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const page = this.viewer.pageIndexAt(cx, cy) ?? this.viewer.currentPageIndex;
    const size = this.viewer.pageSize(page);
    const center = this.viewer.toPagePoint(page, cx, cy);

    let width = Math.min(DEFAULT_WIDTH[role], size.width * 0.45);
    let height = (width * ink.height) / ink.width;
    if (height > size.height * 0.2) {
      height = size.height * 0.2;
      width = (height * ink.width) / ink.height;
    }
    let x = clamp(center.x - width / 2, 0, size.width - width);
    let y = clamp(center.y - height / 2, 0, size.height - height);
    // If a signature is already in that exact spot, shift the new one a little so it's visible.
    const others = this.additions.onPage(page).filter((a) => a.kind === "signature");
    for (let tries = 0; tries < 10 && others.some((o) => Math.abs(o.x - x) < 4 && Math.abs(o.y - y) < 4); tries++) {
      x = clamp(x + 14, 0, size.width - width);
      y = clamp(y + 14, 0, size.height - height);
    }
    const sig: PlacedSignature = {
      kind: "signature",
      role,
      ...newAdditionMeta(),
      page,
      x,
      y,
      width,
      height,
      ink,
    };
    this.additions.add(sig);
    this.history.record({
      undo: () => this.additions.remove(sig),
      redo: () => this.additions.add(sig),
    });
    this.renderer.select(sig.id);
    showToast("Drag to move. Drag the round corner to resize.");
  }

  private remove(id: string): void {
    const sig = this.additions.get(id);
    if (!sig || (sig.kind !== "signature" && sig.kind !== "text")) return;
    this.additions.remove(sig);
    this.history.record({
      undo: () => this.additions.add(sig),
      redo: () => this.additions.remove(sig),
    });
  }

  // ---------- Selecting, moving and resizing ----------

  private onDown(e: PointerEvent): void {
    const cls = this.viewer.element.classList;
    if (cls.contains("drawing") || cls.contains("texting")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".sig-delete")) return; // handled on click
    const box = target.closest<HTMLElement>(".sig-box");
    if (!box) {
      // Tapping anywhere else clears the selection.
      if (!this.drag) this.renderer.select(null);
      return;
    }
    const sig = this.additions.get(box.dataset.id ?? "");
    if (!sig || (sig.kind !== "signature" && sig.kind !== "text") || this.drag) return;
    e.preventDefault();
    const wasSelected = this.renderer.selectedSignature === sig.id;
    this.renderer.select(sig.id);
    this.viewer.element.setPointerCapture(e.pointerId);
    const p = this.viewer.toPagePoint(sig.page, e.clientX, e.clientY);
    this.drag = {
      pointerId: e.pointerId,
      mode: sig.kind === "signature" && target.closest(".sig-handle") ? "resize" : "move",
      wasSelected,
      before: sig,
      current: { ...sig },
      offsetX: p.x - sig.x,
      offsetY: p.y - sig.y,
    };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const s = d.current;
    const size = this.viewer.pageSize(s.page);
    const p = this.viewer.toPagePoint(s.page, e.clientX, e.clientY);
    if (d.mode === "move") {
      s.x = clamp(p.x - d.offsetX, 0, size.width - s.width);
      s.y = clamp(p.y - d.offsetY, 0, size.height - s.height);
    } else if (s.kind === "signature") {
      // Keep the shape: width and height grow together.
      const aspect = s.ink.height / s.ink.width;
      const maxWidth = Math.min(size.width - s.x, (size.height - s.y) / aspect);
      s.width = clamp(p.x - s.x, Math.min(MIN_WIDTH, maxWidth), maxWidth);
      s.height = s.width * aspect;
    }
    this.renderer.preview(s);
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    const { before, current } = d;
    const moved =
      Math.abs(before.x - current.x) > 0.01 ||
      Math.abs(before.y - current.y) > 0.01 ||
      Math.abs(before.width - current.width) > 0.01;
    if (!moved) {
      // Tapping text that was already selected opens it for editing.
      if (d.wasSelected && before.kind === "text") this.editText(before);
      return;
    }
    const after: Movable = { ...current };
    this.additions.update(after);
    this.history.record({
      undo: () => this.additions.update(before),
      redo: () => this.additions.update(after),
    });
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
