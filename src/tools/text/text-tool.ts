/**
 * The Text tool: add text anywhere, and edit the PDF's own words.
 *
 * - Tap an empty spot to start a new text box; tap added text to edit it;
 *   drag added text to move it.
 * - Tap a line of the PDF's own text to edit it; drag down across lines to
 *   edit them as one paragraph (it rewraps to its original width).
 * - Drag a box anywhere else (for example over words on a scan) to cover it
 *   and type the replacement.
 * - Tapping elsewhere, Done, or Esc finishes typing.
 * - On touch screens, one finger taps and drags; two fingers scroll and zoom.
 * Every finished change can be undone.
 */
import {
  TEXT_LINE_HEIGHT,
  contentSize,
  newAdditionMeta,
  type Additions,
  type TextBox,
  type TextEdit,
} from "../../core/additions";
import type { History } from "../../core/history";
import { lineAt, linesBetween, type Rect, type TextLayoutCache, type TextLine } from "../../core/text-layout";
import type { Tool } from "../../core/tools";
import { showToast } from "../../ui/toast";
import {
  EditEditor,
  shouldShowEditHint,
  targetFromArea,
  targetFromEdit,
  targetFromLines,
  type EditTarget,
} from "./pdf-text-edit";
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
  /** Where the press started, in page points. */
  start: { x: number; y: number };
  hit: TextBox | null;
  editHit: TextEdit | null;
  offsetX: number;
  offsetY: number;
  moved: TextBox | null;
  /** For a drag that isn't moving added text: selecting lines, or drawing a box. */
  drag: "lines" | "area" | null;
  startLine: TextLine | null;
  selected: TextLine[];
  area: Rect | null;
}

/** The smallest box (points) that counts as "cover this area". */
const MIN_AREA = { w: 8, h: 6 };

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
  private editEditor: EditEditor | null = null;
  private press: Press | null = null;
  private preview: HTMLDivElement | null = null;
  private touches = new Set<number>();
  private waitForAllFingersUp = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    private readonly history: History,
    private readonly renderer: OverlayRenderer,
    private readonly textLayout: () => TextLayoutCache | null,
    onDone: () => void,
  ) {
    this.options = new TextOptions(loadTextSettings(), (s) => this.applyToEditor(s), onDone);
    const el = viewer.element;
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", (e) => {
      this.touches.delete(e.pointerId);
      this.cancelPress();
    });
  }

  activate(): void {
    this.active = true;
    this.viewer.setTextMode(true);
    this.options.show();
    void document.fonts?.load(`16px ${FONT}`);
    // Work out where the PDF's own text is on nearby pages, ready for editing.
    const cache = this.textLayout();
    const current = this.viewer.currentPageIndex;
    for (const page of [current, current + 1, current - 1]) {
      if (cache && page >= 0 && page < this.viewer.pageCount) void cache.load(page);
    }
  }

  deactivate(): void {
    this.commit();
    this.cancelPress();
    this.active = false;
    this.viewer.setTextMode(false);
    this.options.hide();
  }

  /** Opens added text, or an edit, for changing (double-click outside the Text tool). */
  edit(item: TextBox | TextEdit): void {
    if (item.kind === "edit") this.openEdit(targetFromEdit(item));
    else this.openEditor(item.page, item.x, item.y, item);
  }

  // ---------- Pointer handling ----------

  private onDown(e: PointerEvent): void {
    if (!this.active || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.pointerType === "touch") {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        // Two fingers: scrolling or zooming, not typing.
        this.waitForAllFingersUp = true;
        this.cancelPress();
        return;
      }
      if (this.waitForAllFingersUp) return;
    }
    if (this.editor && e.target === this.editor.el) return; // moving the caret
    if (this.editEditor && e.target === this.editEditor.el) return;
    const page = this.viewer.pageIndexAt(e.clientX, e.clientY);
    if (page === null) {
      // Tapping the grey area around the pages finishes typing too.
      this.commit();
      return;
    }
    const p = this.viewer.toPagePoint(page, e.clientX, e.clientY);
    const hit = this.textAt(page, p.x, p.y);
    e.preventDefault();
    this.viewer.element.setPointerCapture(e.pointerId);
    this.press = {
      pointerId: e.pointerId,
      page,
      startX: e.clientX,
      startY: e.clientY,
      start: p,
      hit,
      editHit: hit ? null : this.editAt(page, p.x, p.y),
      offsetX: hit ? p.x - hit.x : 0,
      offsetY: hit ? p.y - hit.y : 0,
      moved: null,
      drag: null,
      startLine: null,
      selected: [],
      area: null,
    };
  }

  private onMove(e: PointerEvent): void {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.pointerId) return;
    if (!pr.moved && !pr.drag && Math.hypot(e.clientX - pr.startX, e.clientY - pr.startY) < TAP_SLOP_PX) return;
    const size = this.viewer.pageSize(pr.page);
    const p = this.viewer.toPagePoint(pr.page, e.clientX, e.clientY);
    if (pr.hit) {
      pr.moved = {
        ...pr.hit,
        x: clamp(p.x - pr.offsetX, 0, size.width - pr.hit.width),
        y: clamp(p.y - pr.offsetY, 0, size.height - pr.hit.height),
      };
      this.renderer.preview(pr.moved);
      return;
    }
    if (pr.editHit) return;
    if (!pr.drag) {
      const lines = this.textLayout()?.peek(pr.page);
      pr.startLine = lines ? lineAt(lines, pr.start.x, pr.start.y) : null;
      pr.drag = pr.startLine ? "lines" : "area";
    }
    if (pr.drag === "lines" && pr.startLine) {
      pr.selected = linesBetween(this.textLayout()?.peek(pr.page) ?? [pr.startLine], pr.startLine, p.y);
      this.showPreview(pr.page, pr.selected.map((l) => ({ x: l.x0, y: l.top, w: l.x1 - l.x0, h: l.bottom - l.top })), "lines");
    } else {
      const x = clamp(Math.min(p.x, pr.start.x), 0, size.width);
      const y = clamp(Math.min(p.y, pr.start.y), 0, size.height);
      pr.area = { x, y, w: Math.min(Math.abs(p.x - pr.start.x), size.width - x), h: Math.min(Math.abs(p.y - pr.start.y), size.height - y) };
      this.showPreview(pr.page, [pr.area], "area");
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.touches.size === 0) this.waitForAllFingersUp = false;
    }
    const pr = this.press;
    if (!pr || e.pointerId !== pr.pointerId) return;
    this.press = null;
    this.clearPreview();
    if (pr.hit && pr.moved) {
      this.commit();
      this.update(pr.hit, pr.moved);
      return;
    }
    if (pr.drag === "lines" && pr.selected.length) {
      this.openEdit(targetFromLines(this.viewer, pr.page, pr.selected));
      return;
    }
    if (pr.drag === "area") {
      if (pr.area && pr.area.w >= MIN_AREA.w && pr.area.h >= MIN_AREA.h) this.openEdit(targetFromArea(this.viewer, pr.page, pr.area));
      return;
    }
    // A tap.
    if (pr.hit) {
      this.openEditor(pr.page, pr.hit.x, pr.hit.y, pr.hit);
      return;
    }
    if (pr.editHit) {
      this.openEdit(targetFromEdit(pr.editHit));
      return;
    }
    if (this.editor || this.editEditor) {
      // Tapping elsewhere finishes any typing in progress.
      this.commit();
      return;
    }
    void this.tapOnPage(pr.page, pr.start);
  }

  /** A tap on the page: edit the PDF's line of text there, or start new text. */
  private async tapOnPage(page: number, at: { x: number; y: number }): Promise<void> {
    const lines = (await this.textLayout()?.load(page)) ?? [];
    if (!this.active) return;
    const line = lineAt(lines, at.x, at.y);
    if (line) {
      this.openEdit(targetFromLines(this.viewer, page, [line]));
      return;
    }
    const { size } = this.options.current;
    // Put the middle of the first line where the tap was.
    this.openEditor(page, at.x, at.y - (TEXT_LINE_HEIGHT * size) / 2, null);
  }

  private cancelPress(): void {
    const pr = this.press;
    this.press = null;
    this.clearPreview();
    if (pr?.hit && pr.moved) this.renderer.preview(pr.hit); // put it back
  }

  private editAt(page: number, x: number, y: number): TextEdit | null {
    const items = this.additions.onPage(page).filter((a): a is TextEdit => a.kind === "edit");
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i].cover;
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return items[i];
    }
    return null;
  }

  /** Outlines what a drag will edit: the chosen lines, or the box being drawn. */
  private showPreview(page: number, rects: Rect[], kind: "lines" | "area"): void {
    const overlay = this.viewer.overlay(page);
    if (!overlay) return;
    if (!this.preview || this.preview.parentElement !== overlay) {
      this.clearPreview();
      this.preview = document.createElement("div");
      this.preview.className = "select-preview";
      overlay.append(this.preview);
    }
    const size = this.viewer.pageSize(page);
    this.preview.replaceChildren(
      ...rects.map((r) => {
        const d = document.createElement("div");
        d.className = `select-rect ${kind}`;
        d.style.left = `${(r.x / size.width) * 100}%`;
        d.style.top = `${(r.y / size.height) * 100}%`;
        d.style.width = `${(r.w / size.width) * 100}%`;
        d.style.height = `${(r.h / size.height) * 100}%`;
        return d;
      }),
    );
  }

  private clearPreview(): void {
    this.preview?.remove();
    this.preview = null;
  }

  /** Opens the in-place editor for the PDF's own words (or a covered box). */
  private openEdit(target: EditTarget): void {
    this.commit();
    if (!this.viewer.overlay(target.page)) return;
    this.editEditor = new EditEditor(this.viewer, this.renderer, target, () => this.commit());
    if (!target.existing && shouldShowEditHint()) {
      showToast("Edited words cover the old ones. The old words are still in the file, so search or copy in other apps can find them.", 9000);
    }
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
    this.commitEdit();
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
        // A turned text box keeps its turn; its box swaps width and height.
        const box = contentSize(width, height, ed.existing.turn);
        this.update(ed.existing, { ...ed.existing, text, size: ed.size, color: ed.color, width: box.width, height: box.height });
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

  private commitEdit(): void {
    const ed = this.editEditor;
    if (!ed) return;
    this.editEditor = null;
    const result = ed.finish();
    if (!result) return;
    const before = ed.target.existing;
    if (before) {
      const after: TextEdit = { ...before, ...result };
      this.additions.update(after);
      this.history.record({ undo: () => this.additions.update(before), redo: () => this.additions.update(after) });
      return;
    }
    const item: TextEdit = { kind: "edit", ...newAdditionMeta(), ...result };
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
