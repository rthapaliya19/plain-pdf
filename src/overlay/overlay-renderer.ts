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
import type { Additions, PlacedSignature, Stroke, TextHighlight } from "../core/additions";
import type { EventHub } from "../core/events";
import type { Rect } from "../core/text-layout";
import type { Viewer } from "../viewer/viewer";
import { smoothPath } from "./paths";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Layers {
  highlight: SVGSVGElement;
  ink: SVGSVGElement;
  boxes: HTMLDivElement;
}

export class OverlayRenderer {
  private layers = new Map<number, Layers>();
  private selectedId: string | null = null;

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

  /** Moves or resizes a signature on screen while it is being dragged. */
  preview(sig: PlacedSignature): void {
    const layers = this.layers.get(sig.page);
    if (!layers) return;
    layers.ink.querySelector(`g[data-id="${sig.id}"]`)?.setAttribute("transform", signatureTransform(sig));
    const box = layers.boxes.querySelector<HTMLElement>(`.sig-box[data-id="${sig.id}"]`);
    if (box) placeBox(box, sig, this.viewer.pageSize(sig.page));
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
      } else {
        element = signatureGroup(item);
        layer = layers.ink;
        layers.boxes.append(signatureBox(item, size, item.id === this.selectedId));
      }
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
    layers = { highlight, ink, boxes };
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
  return `translate(${sig.x} ${sig.y}) scale(${sig.width / sig.ink.width} ${sig.height / sig.ink.height})`;
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

function placeBox(box: HTMLElement, sig: PlacedSignature, page: { width: number; height: number }): void {
  box.style.left = `${(sig.x / page.width) * 100}%`;
  box.style.top = `${(sig.y / page.height) * 100}%`;
  box.style.width = `${(sig.width / page.width) * 100}%`;
  box.style.height = `${(sig.height / page.height) * 100}%`;
}

function signatureBox(sig: PlacedSignature, page: { width: number; height: number }, selected: boolean): HTMLDivElement {
  const box = document.createElement("div");
  box.className = selected ? "sig-box selected" : "sig-box";
  box.dataset.id = sig.id;
  box.setAttribute("aria-label", `${sig.role === "initials" ? "Initials" : "Signature"}. Drag to move.`);
  placeBox(box, sig, page);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "sig-delete";
  remove.title = sig.role === "initials" ? "Remove initials" : "Remove signature";
  remove.setAttribute("aria-label", remove.title);
  remove.textContent = "×";

  const handle = document.createElement("div");
  handle.className = "sig-handle";
  handle.title = "Drag to resize";
  handle.setAttribute("aria-label", "Resize signature");

  box.append(remove, handle);
  return box;
}
