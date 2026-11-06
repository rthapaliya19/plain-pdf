/**
 * Editing words that are part of the PDF itself.
 *
 * The old words are covered by a patch in the paper's colour, and the new
 * words are written on top in a matching style (see TextEdit in
 * core/additions.ts). The old words stay in the file underneath, only hidden.
 *
 * - On pages with real text, an edit starts from one line (a tap) or several
 *   lines (a drag); a paragraph rewraps to its original width.
 * - On scans (pictures, no readable text), an edit starts from a box the
 *   person drags; the box is covered and they type the replacement.
 */
import type { TextEdit } from "../../core/additions";
import { FONT_METRICS, SCREEN_FONT, loadFont, wrapText, type FontStyle } from "../../core/fonts";
import type { Rect, TextLine } from "../../core/text-layout";
import type { OverlayRenderer } from "../../overlay/overlay-renderer";
import type { Viewer } from "../../viewer/viewer";
import { sampleColors } from "./colors";

/** Everything an edit needs, before it becomes (or updates) a TextEdit. */
export interface EditTarget {
  page: number;
  cover: Rect;
  coverColor: string;
  x: number;
  y: number;
  /** Width the text wraps at. */
  width: number;
  /** Height of the original words (more than this shows a warning). */
  originalHeight: number;
  style: FontStyle;
  size: number;
  color: string;
  lineHeight: number;
  baselineOffset: number;
  text: string;
  original: string;
  turn?: number;
  existing: TextEdit | null;
}

/** An edit of one or more lines of real text (they must be in reading order). */
export function targetFromLines(viewer: Viewer, page: number, lines: TextLine[]): EditTarget {
  const first = lines[0];
  const last = lines[lines.length - 1];
  const size = first.size;
  const x0 = Math.min(...lines.map((l) => l.x0));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const lineHeight = lines.length > 1 ? (last.baseline - first.baseline) / (lines.length - 1) : 1.2 * size;
  const cover: Rect = {
    x: x0 - 0.15 * size,
    y: first.top - 0.12 * size,
    w: x1 - x0 + 0.3 * size,
    h: last.bottom - first.top + 0.24 * size,
  };
  const colors = sampleColors(viewer.pageCanvas(page), viewer.pageSize(page), cover);
  const text = lines.map((l) => l.text).join(" ");
  return {
    page,
    cover,
    coverColor: colors.paper,
    x: x0,
    y: first.top,
    // A single line gets a little room to grow before wrapping.
    width: (x1 - x0) * (lines.length === 1 ? 1.15 : 1.02) + 1,
    originalHeight: last.bottom - first.top,
    style: { family: first.family, bold: first.bold, italic: first.italic },
    size,
    color: colors.ink,
    lineHeight: Math.max(lineHeight, size),
    baselineOffset: first.baseline - first.top,
    text,
    original: text,
    existing: null,
  };
}

/** An edit of a box drawn over a scan (or any area): cover it and type the replacement. */
export function targetFromArea(viewer: Viewer, page: number, area: Rect): EditTarget {
  const colors = sampleColors(viewer.pageCanvas(page), viewer.pageSize(page), area);
  const size = Math.min(48, Math.max(6, area.h * 0.7));
  const style: FontStyle = { family: "sans", bold: false, italic: false };
  const m = FONT_METRICS.sans;
  return {
    page,
    cover: area,
    coverColor: colors.paper,
    x: area.x + 0.1 * size,
    y: area.y,
    width: Math.max(area.w - 0.2 * size, size),
    originalHeight: area.h,
    style,
    size,
    color: colors.ink,
    lineHeight: 1.2 * size,
    // Centre one line of text in the box.
    baselineOffset: area.h / 2 + ((m.ascent - m.descent) / 2) * size,
    text: "",
    original: "",
    existing: null,
  };
}

export function targetFromEdit(e: TextEdit): EditTarget {
  return {
    page: e.page,
    cover: e.cover,
    coverColor: e.coverColor,
    x: e.x,
    y: e.y,
    width: e.width,
    originalHeight: e.cover.h,
    style: { family: e.family, bold: e.bold, italic: e.italic },
    size: e.size,
    color: e.color,
    lineHeight: e.lineHeight,
    baselineOffset: e.baselineOffset,
    text: e.text,
    original: e.original,
    turn: e.turn,
    existing: e,
  };
}

/** The finished values of an edit (to add or update a TextEdit). */
export type EditResult = Omit<TextEdit, "id" | "order" | "kind">;

const HINT_KEY = "plain-pdf:edit-hint-shown";

/** Shows the one-time reminder that covered words are still in the file. */
export function shouldShowEditHint(): boolean {
  try {
    if (localStorage.getItem(HINT_KEY)) return false;
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // Can't remember: showing it again is fine.
  }
  return true;
}

/** The in-place editor: a text box over the covered words, in the matching style. */
export class EditEditor {
  readonly el: HTMLTextAreaElement;
  private readonly patch: HTMLDivElement;
  private readonly warning: HTMLDivElement;
  private size: number;
  private lineHeight: number;
  private baselineOffset: number;

  constructor(
    private readonly viewer: Viewer,
    private readonly renderer: OverlayRenderer,
    readonly target: EditTarget,
    onFinish: () => void,
  ) {
    this.size = target.size;
    this.lineHeight = target.lineHeight;
    this.baselineOffset = target.baselineOffset;
    const overlay = viewer.overlay(target.page)!;
    const page = viewer.pageSize(target.page);
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;

    // The patch hides the old words while typing.
    this.patch = document.createElement("div");
    this.patch.className = "edit-patch";
    Object.assign(this.patch.style, {
      left: pct(target.cover.x, page.width),
      top: pct(target.cover.y, page.height),
      width: pct(target.cover.w, page.width),
      height: pct(target.cover.h, page.height),
      background: target.coverColor,
    });

    this.el = document.createElement("textarea");
    this.el.className = "text-editor edit-editor";
    this.el.setAttribute("aria-label", "Edit the text");
    this.el.spellcheck = true;
    this.el.value = target.text;
    this.el.style.left = pct(target.x, page.width);
    this.el.style.width = `calc(var(--pt) * ${target.width})`;
    this.el.style.fontFamily = SCREEN_FONT[target.style.family];
    this.el.style.fontWeight = target.style.bold ? "700" : "400";
    this.el.style.fontStyle = target.style.italic ? "italic" : "normal";
    this.el.style.color = target.color;
    this.el.style.background = target.coverColor;
    this.el.addEventListener("input", () => this.layout());
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        onFinish();
      }
    });
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.warning = document.createElement("div");
    this.warning.className = "edit-warning";
    this.warning.hidden = true;
    const note = document.createElement("span");
    note.textContent = "Longer than the original space";
    const shrink = document.createElement("button");
    shrink.type = "button";
    shrink.textContent = "Shrink to fit";
    shrink.addEventListener("pointerdown", (e) => e.stopPropagation());
    shrink.addEventListener("mousedown", (e) => e.preventDefault());
    shrink.addEventListener("click", () => this.shrinkToFit());
    this.warning.append(note, shrink);

    if (target.existing) renderer.hide(target.existing.id);
    overlay.append(this.patch, this.el, this.warning);
    this.layout();
    void loadFont(target.style).then(() => this.layout());
    this.el.focus({ preventScroll: true });
    this.el.setSelectionRange(this.el.value.length, this.el.value.length);
  }

  private lines(text = this.el.value): string[] {
    return wrapText(text || " ", this.target.width, this.target.style, this.size);
  }

  /** Places and sizes the editor so its first line sits on the original baseline. */
  private layout(): void {
    const page = this.viewer.pageSize(this.target.page);
    const m = FONT_METRICS[this.target.style.family];
    const firstBaselineInBox = (this.lineHeight - (m.ascent + m.descent) * this.size) / 2 + m.ascent * this.size;
    const top = this.target.y + this.baselineOffset - firstBaselineInBox;
    const lines = this.lines();
    const height = lines.length * this.lineHeight;
    this.el.style.top = `${(top / page.height) * 100}%`;
    this.el.style.fontSize = `calc(var(--pt) * ${this.size})`;
    this.el.style.lineHeight = `calc(var(--pt) * ${this.lineHeight})`;
    this.el.style.height = `calc(var(--pt) * ${height})`;
    const overflowing = this.overflows(lines.length);
    this.el.classList.toggle("overflowing", overflowing);
    this.warning.hidden = !overflowing;
    this.warning.style.left = `${(this.target.x / page.width) * 100}%`;
    this.warning.style.top = `${((top + height + 0.3 * this.lineHeight) / page.height) * 100}%`;
  }

  private overflows(lineCount: number): boolean {
    const needed = this.baselineOffset + (lineCount - 1) * this.lineHeight + FONT_METRICS[this.target.style.family].descent * this.size;
    return needed > this.target.originalHeight + 0.3 * this.lineHeight;
  }

  /** Makes the text smaller (down to 60% of its size) until it fits the original space. */
  shrinkToFit(): void {
    const start = this.target.size;
    while (this.size > start * 0.6) {
      if (!this.overflows(this.lines().length)) break;
      const next = this.size - start * 0.04;
      const ratio = next / this.size;
      this.size = next;
      this.lineHeight *= ratio;
      this.baselineOffset *= ratio;
    }
    this.layout();
    this.el.focus({ preventScroll: true });
  }

  /** Removes the editor and returns the finished edit, or null if nothing changed. */
  finish(): EditResult | null {
    this.patch.remove();
    this.el.remove();
    this.warning.remove();
    this.renderer.hide(null);
    const t = this.target;
    const text = this.el.value.replace(/\s+$/, "");
    const before = t.existing;
    const unchanged = before
      ? text === before.text && Math.abs(this.size - before.size) < 0.01
      : text === t.original.trim();
    if (unchanged) return null;
    const lines = text ? this.lines(text) : [];
    const height = Math.max(t.originalHeight, this.baselineOffset + Math.max(0, lines.length - 1) * this.lineHeight + this.size * 0.3);
    return {
      page: t.page,
      cover: t.cover,
      coverColor: t.coverColor,
      x: t.x,
      y: t.y,
      width: t.width,
      height,
      turn: t.turn,
      text,
      lines,
      original: t.original,
      size: this.size,
      color: t.color,
      lineHeight: this.lineHeight,
      baselineOffset: this.baselineOffset,
      ...t.style,
    };
  }
}
