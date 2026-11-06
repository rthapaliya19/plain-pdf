/**
 * The chapter list: the PDF's own table of contents, in a panel on the left.
 * On computers it sits beside the pages and stays open while reading; on
 * phones it slides over the pages and closes once a chapter is chosen.
 * The chapter being read is highlighted.
 */
import type { EventHub } from "../core/events";
import type { Matrix, OutlineItem, PdfDocument } from "../core/pdf-engine";
import { icons } from "./icons";

export interface ContentsActions {
  /** Go to page `index` (0-based); `y` is the height on the page as shown (points), or null for the top. */
  goTo(index: number, y: number | null): void;
  /** A chapter entry that's a web link. */
  openExternal(url: string): void;
  /** The Contents button shows when there's a chapter list, and looks pressed while it's open. */
  changed(available: boolean, open: boolean): void;
}

const phone = window.matchMedia("(max-width: 640px)");

interface Node {
  item: OutlineItem;
  parent: Node | null;
  children: Node[];
  /** Built when first shown (some chapter lists are very long). */
  element: HTMLLIElement | null;
}

export class ContentsPanel {
  readonly element: HTMLElement;
  /** Dims the pages behind the panel on phones; tapping it closes the panel. */
  readonly backdrop: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private doc: PdfDocument | null = null;
  private nodes: Node[] = [];
  /** Every entry, in reading order. */
  private flat: Node[] = [];
  private readonly expanded = new Set<OutlineItem>();
  private current: Node | null = null;
  private page = 0;
  private opened = false;
  private loading = 0;

  constructor(
    hub: EventHub,
    private readonly actions: ContentsActions,
  ) {
    this.element = document.createElement("aside");
    this.element.className = "contents-panel";
    this.element.hidden = true;
    this.element.setAttribute("aria-label", "Contents");
    const head = document.createElement("div");
    head.className = "contents-head";
    const title = document.createElement("h2");
    title.textContent = "Contents";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button contents-close";
    close.title = "Close the chapter list";
    close.setAttribute("aria-label", "Close contents");
    close.innerHTML = icons.close;
    close.addEventListener("click", () => this.close());
    head.append(title, close);
    this.list = document.createElement("ul");
    this.list.className = "contents-list";
    this.list.setAttribute("role", "tree");
    this.element.append(head, this.list);

    this.backdrop = document.createElement("div");
    this.backdrop.className = "contents-backdrop";
    this.backdrop.hidden = true;
    this.backdrop.addEventListener("click", () => this.close());

    hub.on("page:changed", ({ page }) => {
      this.page = page - 1;
      this.markCurrent();
    });
    hub.on("document:closed", () => void this.load(null));
    phone.addEventListener("change", () => this.update());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get available(): boolean {
    return this.nodes.length > 0;
  }

  /** Shows the chapter list of `doc`; the button and panel hide if it has none. */
  async load(doc: PdfDocument | null): Promise<void> {
    const ticket = ++this.loading;
    const items = doc ? await doc.outline() : [];
    if (ticket !== this.loading) return;
    const sameList = this.doc !== null && doc !== null && sameTitles(this.nodes, items);
    this.doc = doc;
    const build = (list: OutlineItem[], parent: Node | null): Node[] =>
      list.map((item) => {
        const node: Node = { item, parent, children: [], element: null };
        node.children = build(item.items, node);
        return node;
      });
    this.nodes = build(items, null);
    this.flat = [];
    const walk = (list: Node[]) => list.forEach((n) => (this.flat.push(n), walk(n.children)));
    walk(this.nodes);
    // Keep what was opened up when the same file's pages were only reorganized.
    if (!sameList) {
      this.expanded.clear();
      // A single top entry is usually the document's title: show what's inside it.
      if (this.nodes.length === 1) this.expanded.add(this.nodes[0].item);
    } else {
      const keep = new Set(this.flat.filter((n) => [...this.expanded].some((e) => e.title === n.item.title)).map((n) => n.item));
      this.expanded.clear();
      keep.forEach((i) => this.expanded.add(i));
    }
    this.list.replaceChildren(...this.nodes.map((n) => this.row(n, 0)));
    if (this.nodes.length === 0) this.opened = false;
    this.current = null;
    this.markCurrent();
    this.update();
  }

  open(): void {
    if (!this.available) return;
    this.opened = true;
    this.update();
    this.current?.element?.querySelector<HTMLElement>(":scope > .contents-row")?.scrollIntoView({ block: "nearest" });
    (this.current?.element ?? this.list.querySelector("li"))?.querySelector<HTMLButtonElement>(".contents-link")?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.update();
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /** On phones, Esc closes the panel (returns true if it did). */
  closeIfCovering(): boolean {
    if (!this.opened || !phone.matches) return false;
    this.close();
    return true;
  }

  private update(): void {
    this.element.hidden = !this.opened;
    this.backdrop.hidden = !(this.opened && phone.matches);
    this.element.parentElement?.classList.toggle("contents-open", this.opened);
    this.actions.changed(this.available, this.opened);
  }

  private row(node: Node, level: number): HTMLLIElement {
    const { item } = node;
    const li = document.createElement("li");
    li.className = "contents-item";
    li.setAttribute("role", "treeitem");
    li.style.setProperty("--level", String(level));
    node.element = li;
    const row = document.createElement("div");
    row.className = "contents-row";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "contents-toggle";
    toggle.tabIndex = -1;
    if (node.children.length > 0) {
      toggle.innerHTML = icons.chevron;
      toggle.setAttribute("aria-label", `Show or hide what's in "${item.title}"`);
      toggle.addEventListener("click", () => this.setExpanded(node, !this.expanded.has(item)));
    } else {
      toggle.disabled = true;
      toggle.setAttribute("aria-hidden", "true");
    }
    const link = document.createElement("button");
    link.type = "button";
    link.className = "contents-link";
    const title = document.createElement("span");
    title.className = "contents-title";
    title.textContent = item.title;
    if (item.bold) title.style.fontWeight = "600";
    if (item.italic) title.style.fontStyle = "italic";
    link.append(title);
    if (item.page !== null) {
      const number = document.createElement("span");
      number.className = "contents-page";
      number.textContent = String(item.page + 1);
      link.append(number);
      link.title = `${item.title} (page ${item.page + 1})`;
    } else if (item.url) {
      link.title = item.url;
    } else {
      // Its page was deleted (in Organize pages).
      link.disabled = true;
      link.title = "This page isn't in the document any more";
    }
    link.addEventListener("click", () => this.choose(node));
    link.addEventListener("keydown", (event) => this.onKey(event, node));
    row.append(toggle, link);
    li.append(row);
    if (node.children.length > 0) {
      li.setAttribute("aria-expanded", "false");
      if (this.expanded.has(item)) this.setExpanded(node, true);
    }
    return li;
  }

  private setExpanded(node: Node, expanded: boolean): void {
    const li = node.element;
    if (!li || node.children.length === 0) return;
    if (expanded) this.expanded.add(node.item);
    else this.expanded.delete(node.item);
    li.setAttribute("aria-expanded", String(expanded));
    let group = li.querySelector<HTMLUListElement>(":scope > .contents-group");
    if (expanded && !group) {
      group = document.createElement("ul");
      group.className = "contents-group";
      group.setAttribute("role", "group");
      const level = Number(li.style.getPropertyValue("--level")) + 1;
      group.append(...node.children.map((c) => this.row(c, level)));
      li.append(group);
    }
    if (group) group.hidden = !expanded;
    this.markCurrent();
  }

  private choose(node: Node): void {
    const { item } = node;
    if (item.url && item.page === null) {
      this.actions.openExternal(item.url);
      return;
    }
    if (item.page === null) return;
    this.actions.goTo(item.page, this.spot(item));
    if (phone.matches) this.close();
  }

  /** The chapter's height on its page as shown, if the file gives one and the page is upright. */
  private spot(item: OutlineItem): number | null {
    if (!item.point || item.page === null || !this.doc) return null;
    const m = this.doc.pageToPdf[item.page];
    if (!m || Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) return null;
    return applyInverse(m, item.point)[1];
  }

  /** Arrow keys move through the list; Right and Left open and close a chapter's sections. */
  private onKey(event: KeyboardEvent, node: Node): void {
    const links = [...this.list.querySelectorAll<HTMLButtonElement>(".contents-link")].filter((b) => b.offsetParent !== null);
    const here = links.indexOf(event.currentTarget as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      links[Math.min(Math.max(to, 0), links.length - 1)]?.focus();
    };
    if (event.key === "ArrowDown") move(here + 1);
    else if (event.key === "ArrowUp") move(here - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(links.length - 1);
    else if (event.key === "ArrowRight" && node.children.length > 0) {
      event.preventDefault();
      this.setExpanded(node, true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (this.expanded.has(node.item)) this.setExpanded(node, false);
      else node.parent?.element?.querySelector<HTMLButtonElement>(".contents-link")?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  /** Highlights the chapter being read: the last one starting on or before this page, as far as the list is opened up. */
  private markCurrent(): void {
    let found: Node | null = null;
    for (const n of this.flat) if (n.item.page !== null && n.item.page <= this.page) found = n;
    // Its closest entry that's showing (sections of closed chapters aren't).
    let shown = found;
    while (shown?.parent && ![...ancestors(shown)].every((a) => this.expanded.has(a.item))) shown = shown.parent;
    if (shown === this.current) return;
    this.current?.element?.classList.remove("current");
    this.current?.element?.querySelector(".contents-link")?.removeAttribute("aria-current");
    this.current = shown;
    shown?.element?.classList.add("current");
    shown?.element?.querySelector(".contents-link")?.setAttribute("aria-current", "true");
  }
}

function* ancestors(node: Node): Generator<Node> {
  for (let p = node.parent; p; p = p.parent) yield p;
}

/** Same chapters as before (for keeping which ones were opened up). */
function sameTitles(nodes: Node[], items: OutlineItem[]): boolean {
  return nodes.length === items.length && nodes.every((n, i) => n.item.title === items[i].title);
}

/** Point (x, y) through the inverse of transform `m`. */
function applyInverse(m: Matrix, [x, y]: [number, number]): [number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det];
}
