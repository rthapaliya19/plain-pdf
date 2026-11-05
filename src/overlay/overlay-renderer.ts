/**
 * Shows additions (pen strokes, highlights) on top of each page.
 *
 * Each page gets two see-through SVG layers, sized in PDF points so they
 * scale perfectly with zoom without redrawing:
 *  - a highlight layer, blended with "multiply" so text under it stays dark
 *  - an ink layer on top for pen strokes
 */
import type { Additions, Stroke } from "../core/additions";
import type { EventHub } from "../core/events";
import type { Viewer } from "../viewer/viewer";
import { smoothPath } from "./paths";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Layers {
  highlight: SVGSVGElement;
  ink: SVGSVGElement;
}

export class OverlayRenderer {
  private layers = new Map<number, Layers>();

  constructor(
    private readonly viewer: Viewer,
    private readonly additions: Additions,
    hub: EventHub,
  ) {
    hub.on("document:opened", () => {
      // The viewer made fresh page elements, so start over.
      this.layers.clear();
      for (let page = 0; page < this.viewer.pageCount; page++) this.renderPage(page);
    });
    hub.on("additions:changed", ({ pages }) => pages.forEach((page) => this.renderPage(page)));
  }

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

  endLive(path: SVGPathElement): void {
    path.remove();
  }

  private renderPage(page: number): void {
    const items = this.additions.onPage(page);
    if (items.length === 0 && !this.layers.has(page)) return;
    const layers = this.layersFor(page);
    for (const layer of [layers.highlight, layers.ink]) {
      layer.querySelectorAll("path:not(.live)").forEach((p) => p.remove());
    }
    for (const item of items) {
      if (item.kind !== "stroke") continue;
      const path = strokePath(item);
      const layer = item.tool === "highlighter" ? layers.highlight : layers.ink;
      // Keep any in-progress stroke on top.
      layer.insertBefore(path, layer.querySelector("path.live"));
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
    layers = { highlight: make("layer-highlight"), ink: make("layer-ink") };
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
  return path;
}
