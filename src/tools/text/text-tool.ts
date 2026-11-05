/**
 * The Text tool: tap anywhere on a page and type.
 *
 * - Tap an empty spot to start a new text box; tap existing text to edit it;
 *   drag existing text to move it.
 * - Tapping elsewhere, Done, or Esc finishes typing. An emptied box is removed.
 * - Size and colour apply to the text being typed and to new text.
 * Every finished change can be undone.
 */
import { TEXT_LINE_HEIGHT, newAdditionMeta, type Additions, type TextBox } from "../../core/additions";
import type { History } from "../../core/history";
import type { Tool } from "../../core/tools";
import type { OverlayRenderer } from "../../overlay/overlay-renderer";
import type { Viewer } from "../../viewer/viewer";
import { TextOptions, loadTextSettings, type TextSettings } from "./text-options";

const FONT = "Arimo";
/** A press that moves less than this (screen pixels) is a tap. */
const TAP_SLOP_PX = 6;

interface Editor {
  el: HTMLTextAreaElement;
  page: number;
  x: number;
  y: number;
  size: number;
  color: string;
  existing: TextBox | null;
}

interface Press {
  pointerId: number;
  page: number;
  startX: number;
  startY: number;
  hit: TextBox | null;
  offsetX: number;
  offsetY: number;
  moved: TextBox | null;
}

let measurer: CanvasRenderingContext2D | null = null;

/** Width and height of a block of text, in points. */
export function measureText(text: string, size: number): { width: number; height: number } {
  measurer ??= document.createElement("canvas").getContext("2d");
  const lines = text.split("\n");
  let width = 0;
  if (measurer) {
    measurer.font = `${size}px ${FONT}, Arial, sans-serif`;
    for (const line of lines) width = Math.max(width, measurer.measureText(line).width);
  } else {
    width = Math.max(...lines.map((l) => l.length)) * size * 0.55;
  }
  return { width, height: lines.length * TEXT_LINE_HEIGHT * size };
}

export class TextTool implements Tool {
  readonly id = "text";
  readonly options: TextOptions;
  private active = false;
  private editor: Editor | null = null;
  private press: Press | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    private readonly history: History,
    private readonly renderer: OverlayRenderer,
    onDone: () => void,
  ) {
    this.options = new TextOptions(loadTextSettings(), (s) => this.applyToEditor(s), onDone);
    const el = viewer.element;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", () => (this.press = null));
  }

  activate(): void {
    this.active = true;
    this.viewer.setTextMode(true);
    this.options.show();
    void document.fonts?.load(`16px ${FONT}`);
  }

  deactivate(): void {
    this.commit();
    this.press = null;
    this.active = false;
    this.viewer.setTextMode(false);
    this.options.hide();
  }

  /** Opens existing text for editing (used when double-clicking text outside the Text tool). */
  edit(item: TextBox): void {
    this.openEditor(item.page, item.x, item.y, item);
  }

  // ---------- Pointer handling ----------

  private onDown(e: PointerEvent): void {
    if (!this.active || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (this.editor && e.target === this.editor.el) return; // moving the caret
    const page = this.viewer.pageIndexAt(e.clientX, e.clientY);
    if (page === null) {
      // Tapping the grey area around the pages finishes typing too.
      this.commit();
      return;
    }
    const p = this.viewer.toPagePoint(page, e.clientX, e.clientY);
    const hit = this.textAt(page, p.x, p.y);
    if (hit) {
      // Pressing on text: a tap edits it, a drag moves it.
      e.preventDefault();
      this.viewer.element.setPointerCapture(e.pointerId);
    }
    this.press = {
      pointerId: e.pointerId,
      page,
      startX: e.clientX,
      startY: e.clientY,
      hit,
      offsetX: hit ? p.x - hit.x : 0,
      offsetY: hit ? p.y - hit.y : 0,
      moved: null,
    };
  }

  private onMove(e: PointerEvent): void {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.pointerId || !pr.hit) return;
    if (!pr.moved && Math.hypot(e.clientX - pr.startX, e.clientY - pr.startY) < TAP_SLOP_PX) return;
    const size = this.viewer.pageSize(pr.page);
    const p = this.viewer.toPagePoint(pr.page, e.clientX, e.clientY);
    pr.moved = {
      ...pr.hit,
      x: clamp(p.x - pr.offsetX, 0, size.width - pr.hit.width),
      y: clamp(p.y - pr.offsetY, 0, size.height - pr.hit.height),
    };
    this.renderer.preview(pr.moved);
  }

  private onUp(e: PointerEvent): void {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.pointerId) return;
    this.press = null;
    if (pr.hit && pr.moved) {
      this.commit();
      this.update(pr.hit, pr.moved);
      return;
    }
    if (Math.hypot(e.clientX - pr.startX, e.clientY - pr.startY) >= TAP_SLOP_PX) return; // a scroll
    if (pr.hit) {
      this.openEditor(pr.page, pr.hit.x, pr.hit.y, pr.hit);
      return;
    }
    // A tap on an empty spot: finish any typing in progress, or start new text.
    if (this.editor) {
      this.commit();
      return;
    }
    const p = this.viewer.toPagePoint(pr.page, e.clientX, e.clientY);
    const { size } = this.options.current;
    // Put the middle of the first line where the tap was.
    this.openEditor(pr.page, p.x, p.y - (TEXT_LINE_HEIGHT * size) / 2, null);
  }

  private textAt(page: number, x: number, y: number): TextBox | null {
    const pad = 4;
    const items = this.additions.onPage(page).filter((a): a is TextBox => a.kind === "text");
    for (let i = items.length - 1; i >= 0; i--) {
      const t = items[i];
      if (x >= t.x - pad && x <= t.x + t.width + pad && y >= t.y - pad && y <= t.y + t.height + pad) return t;
    }
    return null;
  }

  // ---------- Typing ----------

  private openEditor(page: number, x: number, y: number, existing: TextBox | null): void {
    this.commit();
    const overlay = this.viewer.overlay(page);
    if (!overlay) return;
    const settings = existing ? { size: existing.size, color: existing.color } : this.options.current;
    const pageSize = this.viewer.pageSize(page);
    x = clamp(x, 0, pageSize.width - 10);
    y = clamp(y, 0, pageSize.height - TEXT_LINE_HEIGHT * settings.size);

    const el = document.createElement("textarea");
    el.className = "text-editor";
    el.setAttribute("aria-label", "Type your text");
    el.spellcheck = true;
    el.rows = 1;
    el.value = existing?.text ?? "";
    el.style.left = `${(x / pageSize.width) * 100}%`;
    el.style.top = `${(y / pageSize.height) * 100}%`;
    el.addEventListener("input", () => this.autosize());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.commit();
      }
    });
    // Stop taps inside the box from reaching the page (so they place the caret).
    el.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.editor = { el, page, x, y, size: settings.size, color: settings.color, existing };
    if (existing) this.renderer.hide(existing.id);
    this.options.reflect(settings);
    overlay.append(el);
    this.styleEditor();
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }

  private applyToEditor(settings: TextSettings): void {
    if (!this.editor) return;
    this.editor.size = settings.size;
    this.editor.color = settings.color;
    this.styleEditor();
    this.editor.el.focus({ preventScroll: true });
  }

  private styleEditor(): void {
    const ed = this.editor;
    if (!ed) return;
    ed.el.style.color = ed.color;
    ed.el.style.fontSize = `calc(var(--pt) * ${ed.size})`;
    this.autosize();
  }

  private autosize(): void {
    const ed = this.editor;
    if (!ed) return;
    const { width, height } = measureText(ed.el.value || " ", ed.size);
    // A little extra room on the right for the caret.
    ed.el.style.width = `calc(var(--pt) * ${Math.max(width + ed.size, ed.size * 2)})`;
    ed.el.style.height = `calc(var(--pt) * ${height})`;
  }

  /** Finishes typing, if any: adds, changes or removes the text (with undo). */
  commit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.el.remove();
    this.renderer.hide(null);
    const text = ed.el.value.replace(/\s+$/, "");
    const { width, height } = measureText(text || " ", ed.size);
    if (ed.existing) {
      if (!text) {
        const removed = ed.existing;
        this.additions.remove(removed);
        this.history.record({ undo: () => this.additions.add(removed), redo: () => this.additions.remove(removed) });
      } else if (text !== ed.existing.text || ed.size !== ed.existing.size || ed.color !== ed.existing.color) {
        this.update(ed.existing, { ...ed.existing, text, size: ed.size, color: ed.color, width, height });
      }
      return;
    }
    if (!text) return;
    const item: TextBox = {
      kind: "text",
      ...newAdditionMeta(),
      page: ed.page,
      x: ed.x,
      y: ed.y,
      width,
      height,
      text,
      size: ed.size,
      color: ed.color,
    };
    this.additions.add(item);
    this.history.record({ undo: () => this.additions.remove(item), redo: () => this.additions.add(item) });
  }

  private update(before: TextBox, after: TextBox): void {
    this.additions.update(after);
    this.history.record({ undo: () => this.additions.update(before), redo: () => this.additions.update(after) });
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
