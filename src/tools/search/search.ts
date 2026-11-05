/**
 * Search: a bar to find words in the document. Matches are briefly
 * highlighted on the pages (never saved), with "3 of 17" and arrows.
 * Ignores upper and lower case. Scanned pages have no text to search.
 */
import type { EventHub } from "../../core/events";
import type { PdfDocument } from "../../core/pdf-engine";
import type { Rect } from "../../core/text-layout";
import { icons } from "../../ui/icons";
import type { Viewer } from "../../viewer/viewer";
import { buildPageText, findAll, matchRects, normaliseQuery, type PageText } from "./page-text";

interface Match {
  page: number;
  rects: Rect[];
}

export class Search {
  readonly element: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLSpanElement;
  private doc: PdfDocument | null = null;
  private texts = new Map<number, PageText>();
  private matches: Match[] = [];
  private current = -1;
  private run = 0;
  private timer = 0;

  constructor(
    private readonly viewer: Viewer,
    hub: EventHub,
    private readonly getDocument: () => PdfDocument | null,
  ) {
    this.element = document.createElement("div");
    this.element.className = "search-bar";
    this.element.setAttribute("role", "search");
    this.element.hidden = true;

    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "search-input";
    this.input.placeholder = "Search";
    this.input.setAttribute("aria-label", "Search the document");
    this.input.enterKeyHint = "search";
    this.status = document.createElement("span");
    this.status.className = "search-status";
    this.status.setAttribute("aria-live", "polite");

    const prev = button(icons.up, "Previous match (Shift+Enter)");
    const next = button(icons.down, "Next match (Enter)");
    const close = button(icons.close, "Close search (Esc)");
    prev.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));
    close.addEventListener("click", () => this.close());
    this.element.append(this.input, this.status, prev, next, close);

    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.find(), 200);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    hub.on("document:opened", () => {
      this.close();
      this.texts.clear();
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(): void {
    if (!this.getDocument()) return;
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.run++;
    this.element.hidden = true;
    this.matches = [];
    this.current = -1;
    this.status.textContent = "";
    this.clearMarks();
  }

  private async find(): Promise<void> {
    const doc = this.getDocument();
    const query = normaliseQuery(this.input.value);
    const run = ++this.run;
    this.matches = [];
    this.current = -1;
    this.clearMarks();
    if (!doc || !query) {
      this.status.textContent = "";
      return;
    }
    if (doc !== this.doc) {
      this.doc = doc;
      this.texts.clear();
    }
    this.status.textContent = "Searching…";
    let anyText = false;
    for (let page = 0; page < doc.pageCount; page++) {
      let text = this.texts.get(page);
      if (!text) {
        text = buildPageText(await doc.textFragments(page).catch(() => []));
        this.texts.set(page, text);
      }
      if (run !== this.run) return; // a newer search started
      if (text.text.length > 0) anyText = true;
      for (const start of findAll(text, query)) {
        this.matches.push({ page, rects: matchRects(text, start, query.length) });
        this.mark(this.matches.length - 1);
      }
      if (this.current === -1 && this.matches.length > 0) this.select(0);
      else this.showCount();
    }
    if (this.matches.length === 0) {
      this.status.textContent = anyText ? "No matches" : "No searchable text (scanned pages are pictures)";
    }
  }

  private step(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.select((this.current + direction + this.matches.length) % this.matches.length);
  }

  private select(index: number): void {
    const old = this.matches[this.current];
    if (old) this.markElements(this.current).forEach((el) => el.classList.remove("current"));
    this.current = index;
    const match = this.matches[index];
    this.markElements(index).forEach((el) => el.classList.add("current"));
    this.viewer.reveal(match.page, match.rects[0].x, match.rects[0].y);
    this.showCount();
  }

  private showCount(): void {
    this.status.textContent = this.matches.length ? `${this.current + 1} of ${this.matches.length}` : "Searching…";
  }

  // ----- Marks on the pages -----

  private mark(index: number): void {
    const match = this.matches[index];
    const pageEl = this.viewer.pageElement(match.page);
    if (!pageEl) return;
    let layer = pageEl.querySelector<HTMLDivElement>(".search-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "search-layer";
      pageEl.append(layer);
    }
    const size = this.viewer.pageSize(match.page);
    for (const r of match.rects) {
      const el = document.createElement("div");
      el.className = "search-hit";
      el.dataset.match = String(index);
      el.style.left = `${(r.x / size.width) * 100}%`;
      el.style.top = `${(r.y / size.height) * 100}%`;
      el.style.width = `${(r.w / size.width) * 100}%`;
      el.style.height = `${(r.h / size.height) * 100}%`;
      layer.append(el);
    }
  }

  private markElements(index: number): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`.search-hit[data-match="${index}"]`)];
  }

  private clearMarks(): void {
    document.querySelectorAll(".search-layer").forEach((l) => l.remove());
  }
}

function button(icon: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = icon;
  return b;
}
