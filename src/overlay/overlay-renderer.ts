/**
 * Shows additions on top of each page.
 *
 * Each page gets two see-through SVG layers, sized in PDF points so they
 * scale perfectly with zoom without redrawing:
 *  - a highlight layer, blended with "multiply" so text under it stays dark
 *  - an ink layer on top, for pen strokes and signatures
 * Signatures also get an invisible box on top that you can tap, drag and
 * resize.
 */
import {
  TEXT_BASELINE,
  TEXT_LINE_HEIGHT,
  boxMatrix,
  contentSize,
  type Additions,
  type PlacedSignature,
  type Stroke,
  type TextBox,
  type TextHighlight,
} from "../core/additions";
import type { EventHub } from "../core/events";
import type { Rect } from "../core/text-layout";
import type { Viewer } from "../viewer/viewer";
import { smoothPath } from "./paths";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Layers {
  highlight: SVGSVGElement;
  ink: SVGSVGElement;
  boxes: HTMLDivElement;
  overlay: HTMLDivElement;
}

/** Additions you can tap, drag and remove: signatures, initials and text. */
type Movable = PlacedSignature | TextBox;

export class OverlayRenderer {
  private layers = new Map<number, Layers>();
  private selectedId: string | null = null;
  private hiddenId: string | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    hub: EventHub,
  ) {
    hub.on("document:opened", () => {
      // The viewer made fresh page elements, so start over.
      this.layers.clear();
      this.selectedId = null;
      for (let page = 0; page < this.viewer.pageCount; page++) this.renderPage(page);
    });
    hub.on("additions:changed", ({ pages }) => pages.forEach((page) => this.renderPage(page)));
  }

  // ---------- In-progress drawing ----------

  /** Adds an in-progress stroke to the screen. Update it with `updateLive`. */
  beginLive(stroke: Stroke): SVGPathElement {
    const layers = this.layersFor(stroke.page);
    const path = strokePath(stroke);
    path.classList.add("live");
    (stroke.tool === "highlighter" ? layers.highlight : layers.ink).append(path);
    return path;
  }

  updateLive(path: SVGPathElement, stroke: Stroke): void {
    path.setAttribute("d", smoothPath(stroke.points));
  }

  /** Adds an in-progress text highlight. Update it with `updateLiveRects`. */
  beginLiveRects(page: number): SVGGElement {
    const g = document.createElementNS(SVG_NS, "g");
    g.classList.add("live");
    this.layersFor(page).highlight.append(g);
    return g;
  }

  updateLiveRects(g: SVGGElement, rects: Rect[], color: string): void {
    g.replaceChildren(...rects.map((r) => rectElement(r, color)));
  }

  endLive(element: SVGElement): void {
    element.remove();
  }

  // ---------- Signatures ----------

  get selectedSignature(): string | null {
    return this.selectedId;
  }

  /** Shows the move/resize/delete controls on one signature (or none). */
  select(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    for (const layers of this.layers.values()) {
      layers.boxes.querySelectorAll<HTMLElement>(".sig-box").forEach((box) => {
        box.classList.toggle("selected", box.dataset.id === id);
      });
    }
  }

  /** Moves or resizes a signature or text on screen while it is being dragged. */
  preview(item: Movable): void {
    const layers = this.layers.get(item.page);
    if (!layers) return;
    const transform = item.kind === "signature" ? signatureTransform(item) : textTransform(item);
    layers.ink.querySelector(`g[data-id="${item.id}"]`)?.setAttribute("transform", transform);
    const box = layers.boxes.querySelector<HTMLElement>(`.sig-box[data-id="${item.id}"]`);
    if (box) placeBox(box, item, this.viewer.pageSize(item.page));
  }

  /** Hides one addition (while it is being edited in place). */
  hide(id: string | null): void {
    this.hiddenId = id;
    for (const layers of this.layers.values()) {
      for (const el of layers.overlay.querySelectorAll<HTMLElement | SVGElement>("[data-id]")) {
        el.classList.toggle("being-edited", el.dataset.id === id);
      }
    }
  }

  // ---------- Drawing everything ----------

  private renderPage(page: number): void {
    if (page >= this.viewer.pageCount) return;
    const items = this.additions.onPage(page);
    if (items.length === 0 && !this.layers.has(page)) return;
    const layers = this.layersFor(page);
    for (const layer of [layers.highlight, layers.ink]) {
      for (const child of [...layer.children]) if (!child.classList.contains("live")) child.remove();
    }
    layers.boxes.replaceChildren();

    const size = this.viewer.pageSize(page);
    for (const item of items) {
      let element: SVGElement;
      let layer: SVGSVGElement;
      if (item.kind === "stroke") {
        element = strokePath(item);
        layer = item.tool === "highlighter" ? layers.highlight : layers.ink;
      } else if (item.kind === "highlight") {
        element = highlightGroup(item);
        layer = layers.highlight;
      } else if (item.kind === "text") {
        element = textGroup(item);
        layer = layers.ink;
        layers.boxes.append(itemBox(item, size, item.id === this.selectedId));
      } else {
        element = signatureGroup(item);
        layer = layers.ink;
        layers.boxes.append(itemBox(item, size, item.id === this.selectedId));
      }
      if (item.id === this.hiddenId) element.classList.add("being-edited");
      // Keep any in-progress drawing on top.
      layer.insertBefore(element, layer.querySelector(":scope > .live"));
    }
  }

  private layersFor(page: number): Layers {
    let layers = this.layers.get(page);
    if (layers && layers.ink.isConnected) return layers;
    const overlay = this.viewer.overlay(page)!;
    const { width, height } = this.viewer.pageSize(page);
    const make = (className: string) => {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", `layer ${className}`);
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      overlay.append(svg);
      return svg;
    };
    const highlight = make("layer-highlight");
    const ink = make("layer-ink");
    const boxes = document.createElement("div");
    boxes.className = "layer-boxes";
    overlay.append(boxes);
    layers = { highlight, ink, boxes, overlay };
    this.layers.set(page, layers);
    return layers;
  }
}

function strokePath(stroke: Stroke): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", smoothPath(stroke.points));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", stroke.color);
  path.setAttribute("stroke-width", String(stroke.width));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.dataset.id = stroke.id;
  path.dataset.kind = stroke.kind;
  return path;
}

function rectElement(r: Rect, color: string): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", String(r.x));
  rect.setAttribute("y", String(r.y));
  rect.setAttribute("width", String(r.w));
  rect.setAttribute("height", String(r.h));
  rect.setAttribute("rx", String(Math.min(2, r.h * 0.15)));
  rect.setAttribute("fill", color);
  return rect;
}

function highlightGroup(item: TextHighlight): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.dataset.id = item.id;
  g.dataset.kind = item.kind;
  g.append(...item.rects.map((r) => rectElement(r, item.color)));
  return g;
}

function signatureTransform(sig: PlacedSignature): string {
  const c = contentSize(sig.width, sig.height, sig.turn);
  return `matrix(${boxMatrix(sig.x, sig.y, sig.width, sig.height, sig.turn).join(" ")}) scale(${c.width / sig.ink.width} ${c.height / sig.ink.height})`;
}

function textTransform(t: TextBox): string {
  return `matrix(${boxMatrix(t.x, t.y, t.width, t.height, t.turn).join(" ")})`;
}

function signatureGroup(sig: PlacedSignature): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.dataset.id = sig.id;
  g.dataset.kind = sig.kind;
  g.setAttribute("transform", signatureTransform(sig));
  for (const points of sig.ink.strokes) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", smoothPath(points));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", sig.ink.color);
    path.setAttribute("stroke-width", String(sig.ink.lineWidth));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    g.append(path);
  }
  return g;
}

function textGroup(item: TextBox): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.dataset.id = item.id;
  g.dataset.kind = item.kind;
  g.setAttribute("transform", textTransform(item));
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "added-text");
  text.setAttribute("font-size", String(item.size));
  text.setAttribute("fill", item.color);
  item.text.split("\n").forEach((line, i) => {
    const span = document.createElementNS(SVG_NS, "tspan");
    span.setAttribute("x", "0");
    span.setAttribute("y", String((TEXT_BASELINE + i * TEXT_LINE_HEIGHT) * item.size));
    span.textContent = line || " ";
    text.append(span);
  });
  g.append(text);
  return g;
}

function placeBox(box: HTMLElement, sig: Movable, page: { width: number; height: number }): void {
  box.style.left = `${(sig.x / page.width) * 100}%`;
  box.style.top = `${(sig.y / page.height) * 100}%`;
  box.style.width = `${(sig.width / page.width) * 100}%`;
  box.style.height = `${(sig.height / page.height) * 100}%`;
}

function itemBox(item: Movable, page: { width: number; height: number }, selected: boolean): HTMLDivElement {
  const box = document.createElement("div");
  box.className = `sig-box${item.kind === "text" ? " text-box" : ""}${selected ? " selected" : ""}`;
  box.dataset.id = item.id;
  const name = item.kind === "text" ? "Text" : item.role === "initials" ? "Initials" : "Signature";
  box.setAttribute(
    "aria-label",
    item.kind === "text" ? "Text. Drag to move, double-click to edit." : `${name}. Drag to move.`,
  );
  placeBox(box, item, page);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "sig-delete";
  remove.title = `Remove ${name.toLowerCase()}`;
  remove.setAttribute("aria-label", remove.title);
  remove.textContent = "×";
  box.append(remove);

  if (item.kind === "signature") {
    const handle = document.createElement("div");
    handle.className = "sig-handle";
    handle.title = "Drag to resize";
    handle.setAttribute("aria-label", "Resize");
    box.append(handle);
  }
  return box;
}
