/**
 * The top toolbar: Open, file name, page number and zoom.
 * Later phases add their buttons (Pen, Sign, Undo, Save) here.
 */
import type { EventHub } from "../core/events";
import { icons } from "./icons";

export interface ToolbarActions {
  open(): void;
  zoomIn(): void;
  zoomOut(): void;
  fitToWidth(): void;
  goToPage(page: number): void;
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly fileName: HTMLSpanElement;
  private readonly docControls: HTMLDivElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLSpanElement;
  private readonly zoomLabel: HTMLButtonElement;
  private page = 1;

  constructor(hub: EventHub, actions: ToolbarActions) {
    this.element = document.createElement("header");
    this.element.className = "toolbar";

    const open = iconButton(icons.open, "Open", "Open a PDF (Ctrl+O)");
    open.classList.add("open-button");
    open.addEventListener("click", () => actions.open());

    this.fileName = document.createElement("span");
    this.fileName.className = "file-name";

    // Page number: type a number and press Enter to jump there.
    this.pageInput = document.createElement("input");
    this.pageInput.className = "page-input";
    this.pageInput.type = "text";
    this.pageInput.inputMode = "numeric";
    this.pageInput.setAttribute("aria-label", "Page number");
    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    this.pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const wanted = parseInt(this.pageInput.value, 10);
        if (Number.isFinite(wanted)) actions.goToPage(wanted);
        this.pageInput.blur();
      } else if (event.key === "Escape") {
        this.pageInput.blur();
      }
    });
    this.pageInput.addEventListener("blur", () => {
      this.pageInput.value = String(this.page);
    });
    this.pageTotal = document.createElement("span");
    this.pageTotal.className = "page-total";
    const pageGroup = document.createElement("div");
    pageGroup.className = "page-group";
    pageGroup.append(this.pageInput, this.pageTotal);

    const zoomOut = iconButton(icons.minus, "", "Zoom out (Ctrl+-)");
    zoomOut.addEventListener("click", () => actions.zoomOut());
    const zoomIn = iconButton(icons.plus, "", "Zoom in (Ctrl+=)");
    zoomIn.addEventListener("click", () => actions.zoomIn());
    this.zoomLabel = document.createElement("button");
    this.zoomLabel.type = "button";
    this.zoomLabel.className = "zoom-label";
    this.zoomLabel.title = "Fit to window (Ctrl+0)";
    this.zoomLabel.addEventListener("click", () => actions.fitToWidth());
    const zoomGroup = document.createElement("div");
    zoomGroup.className = "zoom-group";
    zoomGroup.append(zoomOut, this.zoomLabel, zoomIn);

    this.docControls = document.createElement("div");
    this.docControls.className = "doc-controls";
    this.docControls.hidden = true;
    this.docControls.append(pageGroup, zoomGroup);

    this.element.append(open, this.fileName, this.docControls);

    hub.on("document:opened", ({ name, pageCount }) => {
      this.fileName.textContent = name;
      this.fileName.title = name;
      this.pageTotal.textContent = `/ ${pageCount}`;
      this.pageInput.style.width = `${String(pageCount).length + 1.5}ch`;
      this.docControls.hidden = false;
    });
    hub.on("document:closed", () => {
      this.fileName.textContent = "";
      this.docControls.hidden = true;
    });
    hub.on("page:changed", ({ page }) => {
      this.page = page;
      if (document.activeElement !== this.pageInput) this.pageInput.value = String(page);
    });
    hub.on("zoom:changed", ({ zoom }) => {
      this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    });
  }
}

function iconButton(icon: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-button";
  b.title = title;
  b.setAttribute("aria-label", label || title);
  b.innerHTML = icon;
  if (label) {
    const text = document.createElement("span");
    text.className = "button-label";
    text.textContent = label;
    b.append(text);
  }
  return b;
}
