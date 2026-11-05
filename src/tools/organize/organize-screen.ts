/**
 * Organize pages: a grid of small page previews, shown only when opened
 * from the More menu.
 *
 * - Tap pages to select them (Shift-click selects a range on computers).
 * - Rotate, delete, or save the selected pages as a new PDF.
 * - Drag a page (or the selected pages) to a new place. On touch screens,
 *   press and hold a page for a moment, then drag.
 * - Add pages from other PDFs to the end.
 * Everything can be undone.
 */
import type { EventHub } from "../../core/events";
import type { PdfDocument } from "../../core/pdf-engine";
import { icons } from "../../ui/icons";

export interface OrganizeActions {
  doc(): PdfDocument | null;
  /** A key for page i's look (file, page and rotation), to reuse previews. */
  pageKey(i: number): string;
  rotate(pages: number[], by: number): void;
  remove(pages: number[]): boolean;
  move(pages: number[], before: number): void;
  addFiles(files: File[]): Promise<void>;
  saveSelected(pages: number[]): Promise<void>;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

/** Preview width in CSS pixels. */
const THUMB_WIDTH = 150;
const LONG_PRESS_MS = 350;

interface Press {
  pointerId: number;
  pos: number;
  x: number;
  y: number;
  touch: boolean;
  timer: number;
  dragging: boolean;
}

export class OrganizeScreen {
  readonly element: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly buttons: Record<"rotateLeft" | "rotateRight" | "remove" | "save" | "undo" | "redo" | "selectAll", HTMLButtonElement>;
  private readonly fileInput: HTMLInputElement;
  private selection = new Set<number>();
  private lastClicked: number | null = null;
  private thumbs = new Map<string, HTMLCanvasElement>();
  private observer: IntersectionObserver | null = null;
  private press: Press | null = null;
  private ghost: HTMLElement | null = null;
  private dropBefore: number | null = null;
  private suppressClick = false;
  private scrollFrame = 0;
  private lastPointer = { x: 0, y: 0 };

  constructor(hub: EventHub, private readonly actions: OrganizeActions) {
    this.element = document.createElement("div");
    this.element.className = "organize";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", "Organize pages");
    this.element.hidden = true;

    // ----- Top bar -----
    const top = document.createElement("header");
    top.className = "organize-bar";
    const done = textButton(icons.check, "Done", "done-button");
    done.addEventListener("click", () => this.close());
    const title = document.createElement("h2");
    title.textContent = "Organize pages";
    this.count = document.createElement("span");
    this.count.className = "organize-count";
    const undo = textButton(icons.undo, "Undo", "icon-button");
    const redo = textButton(icons.redo, "Redo", "icon-button");
    undo.addEventListener("click", () => actions.undo());
    redo.addEventListener("click", () => actions.redo());
    const selectAll = textButton(icons.pages, "Select all", "icon-button");
    selectAll.addEventListener("click", () => this.toggleAll());
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    top.append(done, title, this.count, spacer, undo, redo, selectAll);

    // ----- Grid -----
    this.grid = document.createElement("div");
    this.grid.className = "organize-grid";

    // ----- Bottom bar -----
    const bottom = document.createElement("footer");
    bottom.className = "organize-actions";
    const rotateLeft = textButton(icons.rotateLeft, "Rotate left", "icon-button");
    const rotateRight = textButton(icons.rotateRight, "Rotate right", "icon-button");
    const remove = textButton(icons.trash, "Delete", "icon-button");
    const save = textButton(icons.save, "Save as new PDF", "icon-button");
    const add = textButton(icons.addFile, "Add pages", "icon-button");
    rotateLeft.addEventListener("click", () => actions.rotate(this.selected(), 270));
    rotateRight.addEventListener("click", () => actions.rotate(this.selected(), 90));
    remove.addEventListener("click", () => this.removeSelected());
    save.addEventListener("click", () => void actions.saveSelected(this.selected()));
    add.addEventListener("click", () => this.fileInput.click());
    bottom.append(rotateLeft, rotateRight, remove, save, separator(), add);
    this.buttons = { rotateLeft, rotateRight, remove, save, undo, redo, selectAll };

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "application/pdf,.pdf";
    this.fileInput.multiple = true;
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = "";
      void actions.addFiles(files).then(() => {
        this.grid.scrollTop = this.grid.scrollHeight;
      });
    });

    this.element.append(top, this.grid, bottom, this.fileInput);
    this.setUpPointer();
    this.element.addEventListener("keydown", (e) => this.onKey(e));
    hub.on("pages:changed", () => this.isOpen && this.render());
    hub.on("history:changed", () => this.isOpen && this.refreshButtons());
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(): void {
    if (!this.actions.doc()) return;
    this.selection.clear();
    this.lastClicked = null;
    this.element.hidden = false;
    this.render();
    this.element.querySelector<HTMLElement>(".done-button")?.focus();
  }

  close(): void {
    this.cancelDrag();
    this.element.hidden = true;
    this.observer?.disconnect();
    this.grid.replaceChildren();
  }

  /** Asks to choose PDFs whose pages are added to the end. */
  chooseFilesToAdd(): void {
    this.fileInput.click();
  }

  private selected(): number[] {
    return [...this.selection].sort((a, b) => a - b);
  }

  // ---------- Drawing the grid ----------

  private render(): void {
    const doc = this.actions.doc();
    if (!doc) return this.close();
    for (const s of [...this.selection]) if (s >= doc.pageCount) this.selection.delete(s);
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) this.drawThumb(entry.target as HTMLElement);
    }, { root: this.grid, rootMargin: "300px 0px" });

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < doc.pageCount; i++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.pos = String(i);
      tile.tabIndex = 0;
      tile.setAttribute("role", "checkbox");
      tile.setAttribute("aria-label", `Page ${i + 1}`);
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      const { width, height } = doc.pageSizes[i];
      thumb.style.aspectRatio = `${width} / ${height}`;
      const num = document.createElement("span");
      num.className = "tile-number";
      num.textContent = String(i + 1);
      const check = document.createElement("span");
      check.className = "tile-check";
      check.innerHTML = icons.check;
      tile.append(thumb, num, check);
      fragment.append(tile);
    }
    this.grid.replaceChildren(fragment);
    for (const tile of this.grid.children) this.observer.observe(tile);
    this.refreshSelection();
  }

  private drawThumb(tile: HTMLElement): void {
    const doc = this.actions.doc();
    const thumb = tile.querySelector<HTMLElement>(".thumb");
    if (!doc || !thumb || thumb.firstChild) return;
    const pos = Number(tile.dataset.pos);
    const key = this.actions.pageKey(pos);
    let canvas = this.thumbs.get(key);
    if (!canvas) {
      canvas = document.createElement("canvas");
      const ppp = (THUMB_WIDTH * Math.min(2, window.devicePixelRatio || 1)) / doc.pageSizes[pos].width;
      doc.renderPage(pos, canvas, ppp).promise.catch(() => {});
      this.thumbs.set(key, canvas);
    } else if (canvas.isConnected) {
      // The same preview is shown elsewhere in the grid: make a copy.
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d")?.drawImage(canvas, 0, 0);
      canvas = copy;
    }
    thumb.append(canvas);
  }

  private refreshSelection(): void {
    const count = this.actions.doc()?.pageCount ?? 0;
    for (const tile of this.grid.querySelectorAll<HTMLElement>(".tile")) {
      const on = this.selection.has(Number(tile.dataset.pos));
      tile.classList.toggle("selected", on);
      tile.setAttribute("aria-checked", String(on));
    }
    const n = this.selection.size;
    this.count.textContent = n ? `${n} of ${count} selected` : `${count} page${count === 1 ? "" : "s"}`;
    this.buttons.selectAll.querySelector("span")!.textContent = n === count && count > 0 ? "Select none" : "Select all";
    this.refreshButtons();
  }

  private refreshButtons(): void {
    const n = this.selection.size;
    const count = this.actions.doc()?.pageCount ?? 0;
    this.buttons.rotateLeft.disabled = n === 0;
    this.buttons.rotateRight.disabled = n === 0;
    this.buttons.save.disabled = n === 0;
    this.buttons.remove.disabled = n === 0 || n >= count;
    this.buttons.remove.title = n >= count && count > 0 ? "A PDF needs at least one page" : "Delete the selected pages";
    this.buttons.undo.disabled = !this.actions.canUndo();
    this.buttons.redo.disabled = !this.actions.canRedo();
  }

  // ---------- Selecting ----------

  private toggle(pos: number, range: boolean): void {
    if (range && this.lastClicked !== null) {
      const [a, b] = [Math.min(this.lastClicked, pos), Math.max(this.lastClicked, pos)];
      for (let i = a; i <= b; i++) this.selection.add(i);
    } else if (this.selection.has(pos)) {
      this.selection.delete(pos);
    } else {
      this.selection.add(pos);
    }
    this.lastClicked = pos;
    this.refreshSelection();
  }

  private toggleAll(): void {
    const count = this.actions.doc()?.pageCount ?? 0;
    if (this.selection.size === count) this.selection.clear();
    else for (let i = 0; i < count; i++) this.selection.add(i);
    this.refreshSelection();
  }

  private removeSelected(): void {
    const pages = this.selected();
    if (this.actions.remove(pages)) this.selection.clear();
    this.refreshSelection();
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (this.press?.dragging) this.cancelDrag();
      else this.close();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selection.size) {
      e.preventDefault();
      e.stopPropagation();
      this.removeSelected();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.toggleAll();
    } else if (e.key === " " || e.key === "Enter") {
      const tile = (e.target as HTMLElement).closest<HTMLElement>(".tile");
      if (tile) {
        e.preventDefault();
        this.toggle(Number(tile.dataset.pos), e.shiftKey);
      }
    }
  }

  // ---------- Dragging to reorder ----------

  private setUpPointer(): void {
    const g = this.grid;
    g.addEventListener("pointerdown", (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>(".tile");
      if (!tile || (e.pointerType === "mouse" && e.button !== 0) || this.press) return;
      const touch = e.pointerType === "touch";
      this.press = { pointerId: e.pointerId, pos: Number(tile.dataset.pos), x: e.clientX, y: e.clientY, touch, timer: 0, dragging: false };
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (touch) {
        // Press and hold to pick up a page (a quick swipe still scrolls).
        this.press.timer = window.setTimeout(() => this.startDrag(), LONG_PRESS_MS);
      }
    });
    g.addEventListener("pointermove", (e) => {
      const p = this.press;
      if (!p || e.pointerId !== p.pointerId) return;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (!p.dragging) {
        if (p.touch && moved > 8) {
          clearTimeout(p.timer); // it's a scroll
          this.press = null;
        } else if (!p.touch && moved > 6) {
          this.startDrag();
        }
        return;
      }
      this.moveGhost(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      const p = this.press;
      if (!p || e.pointerId !== p.pointerId) return;
      clearTimeout(p.timer);
      this.press = null;
      if (p.dragging) {
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        const before = this.dropBefore;
        this.clearDragUi();
        if (!cancelled && before !== null) this.drop(p.pos, before);
      }
    };
    g.addEventListener("pointerup", (e) => end(e, false));
    g.addEventListener("pointercancel", (e) => end(e, true));
    // Once a page is picked up on a touch screen, stop the grid scrolling.
    g.addEventListener("touchmove", (e) => {
      if (this.press?.dragging) e.preventDefault();
    }, { passive: false });
    g.addEventListener("contextmenu", (e) => {
      if (this.press) e.preventDefault();
    });
    g.addEventListener("click", (e) => {
      if (this.suppressClick) return;
      const tile = (e.target as HTMLElement).closest<HTMLElement>(".tile");
      if (tile) this.toggle(Number(tile.dataset.pos), e.shiftKey);
    });
  }

  private startDrag(): void {
    const p = this.press;
    if (!p || p.dragging) return;
    p.dragging = true;
    try {
      this.grid.setPointerCapture(p.pointerId);
    } catch {
      // The pointer may already be gone.
    }
    const moving = this.selection.has(p.pos) ? this.selection.size : 1;
    const source = this.grid.querySelector<HTMLElement>(`.tile[data-pos="${p.pos}"] .thumb`);
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    const canvas = source?.querySelector("canvas");
    if (canvas) {
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d")?.drawImage(canvas, 0, 0);
      ghost.append(copy);
    }
    if (moving > 1) {
      const badge = document.createElement("span");
      badge.className = "drag-count";
      badge.textContent = String(moving);
      ghost.append(badge);
    }
    document.body.append(ghost);
    this.ghost = ghost;
    this.element.classList.add("dragging");
    navigator.vibrate?.(15);
    this.moveGhost(this.lastPointer.x, this.lastPointer.y);
    this.autoScroll();
  }

  private moveGhost(x: number, y: number): void {
    if (!this.ghost) return;
    this.ghost.style.left = `${x}px`;
    this.ghost.style.top = `${y}px`;
    // Where would the page go? Before or after the tile under the pointer.
    const under = document.elementFromPoint(x, y)?.closest<HTMLElement>(".tile");
    this.grid.querySelectorAll(".drop-before, .drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    if (!under) return;
    const pos = Number(under.dataset.pos);
    const r = under.getBoundingClientRect();
    const after = x > r.left + r.width / 2;
    under.classList.add(after ? "drop-after" : "drop-before");
    this.dropBefore = after ? pos + 1 : pos;
  }

  /** Scrolls the grid while dragging near its top or bottom edge. */
  private autoScroll(): void {
    cancelAnimationFrame(this.scrollFrame);
    const step = () => {
      if (!this.press?.dragging) return;
      const r = this.grid.getBoundingClientRect();
      const y = this.lastPointer.y;
      const edge = 60;
      if (y < r.top + edge) this.grid.scrollTop -= 12;
      else if (y > r.bottom - edge) this.grid.scrollTop += 12;
      this.moveGhost(this.lastPointer.x, this.lastPointer.y);
      this.scrollFrame = requestAnimationFrame(step);
    };
    this.scrollFrame = requestAnimationFrame(step);
  }

  private drop(pos: number, before: number): void {
    const pages = this.selection.has(pos) ? this.selected() : [pos];
    const start = before - pages.filter((p) => p < before).length;
    this.actions.move(pages, before);
    // Keep the moved pages selected in their new place.
    this.selection = new Set(pages.map((_, i) => start + i));
    this.refreshSelection();
  }

  private cancelDrag(): void {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
    this.clearDragUi();
  }

  private clearDragUi(): void {
    cancelAnimationFrame(this.scrollFrame);
    this.ghost?.remove();
    this.ghost = null;
    this.dropBefore = null;
    this.element.classList.remove("dragging");
    this.grid.querySelectorAll(".drop-before, .drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after"));
  }
}

function textButton(icon: string, label: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.innerHTML = icon;
  const text = document.createElement("span");
  text.className = "button-label";
  text.textContent = label;
  b.append(text);
  return b;
}

function separator(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "separator";
  return s;
}
