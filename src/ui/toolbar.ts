/**
 * The top toolbar: Open, the tools (Draw, Undo, Redo), file name, page
 * number and zoom. On phones the tools move to a bar at the bottom of the
 * screen, within thumb reach.
 */
import type { EventHub } from "../core/events";
import { icons } from "./icons";

export interface ToolbarActions {
  open(): void;
  toggleDraw(): void;
  undo(): void;
  redo(): void;
  zoomIn(): void;
  zoomOut(): void;
  fitToWidth(): void;
  goToPage(page: number): void;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? "Cmd" : "Ctrl";

export class Toolbar {
  readonly element: HTMLElement;
  private readonly fileName: HTMLSpanElement;
  private readonly toolGroup: HTMLDivElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly docControls: HTMLDivElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLSpanElement;
  private readonly zoomLabel: HTMLButtonElement;
  private page = 1;

  constructor(hub: EventHub, actions: ToolbarActions) {
    this.element = document.createElement("header");
    this.element.className = "toolbar";

    const open = iconButton(icons.open, "Open", `Open a PDF (${MOD}+O)`);
    open.classList.add("open-button");
    open.addEventListener("click", () => actions.open());

    // ----- Tools -----
    this.drawButton = iconButton(icons.pen, "Draw", "Draw, highlight or erase (Esc to stop)");
    this.drawButton.classList.add("tool-button");
    this.drawButton.setAttribute("aria-pressed", "false");
    this.drawButton.addEventListener("click", () => actions.toggleDraw());
    this.undoButton = iconButton(icons.undo, "Undo", `Undo (${MOD}+Z)`);
    this.undoButton.addEventListener("click", () => actions.undo());
    this.redoButton = iconButton(icons.redo, "Redo", isMac ? "Redo (Cmd+Shift+Z)" : "Redo (Ctrl+Y)");
    this.redoButton.addEventListener("click", () => actions.redo());
    this.undoButton.disabled = true;
    this.redoButton.disabled = true;
    this.toolGroup = document.createElement("div");
    this.toolGroup.className = "tool-group";
    this.toolGroup.hidden = true;
    this.toolGroup.append(this.drawButton, separator(), this.undoButton, this.redoButton);

    this.fileName = document.createElement("span");
    this.fileName.className = "file-name";

    // ----- Page number: type a number and press Enter to jump there -----
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

    // ----- Zoom -----
    const zoomOut = iconButton(icons.minus, "", `Zoom out (${MOD}+-)`);
    zoomOut.addEventListener("click", () => actions.zoomOut());
    const zoomIn = iconButton(icons.plus, "", `Zoom in (${MOD}+=)`);
    zoomIn.addEventListener("click", () => actions.zoomIn());
    this.zoomLabel = document.createElement("button");
    this.zoomLabel.type = "button";
    this.zoomLabel.className = "zoom-label";
    this.zoomLabel.title = `Fit to window (${MOD}+0)`;
    this.zoomLabel.addEventListener("click", () => actions.fitToWidth());
    const zoomGroup = document.createElement("div");
    zoomGroup.className = "zoom-group";
    zoomGroup.append(zoomOut, this.zoomLabel, zoomIn);

    this.docControls = document.createElement("div");
    this.docControls.className = "doc-controls";
    this.docControls.hidden = true;
    this.docControls.append(pageGroup, zoomGroup);

    this.element.append(open, this.toolGroup, this.fileName, this.docControls);

    hub.on("document:opened", ({ name, pageCount }) => {
      this.fileName.textContent = name;
      this.fileName.title = name;
      this.pageTotal.textContent = `/ ${pageCount}`;
      this.pageInput.style.width = `${String(pageCount).length + 1.5}ch`;
      this.docControls.hidden = false;
      this.toolGroup.hidden = false;
      document.body.classList.add("has-document");
    });
    hub.on("document:closed", () => {
      this.fileName.textContent = "";
      this.docControls.hidden = true;
      this.toolGroup.hidden = true;
      document.body.classList.remove("has-document");
    });
    hub.on("page:changed", ({ page }) => {
      this.page = page;
      if (document.activeElement !== this.pageInput) this.pageInput.value = String(page);
    });
    hub.on("zoom:changed", ({ zoom }) => {
      this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    });
    hub.on("history:changed", ({ canUndo, canRedo }) => {
      this.undoButton.disabled = !canUndo;
      this.redoButton.disabled = !canRedo;
    });
    hub.on("tool:changed", ({ id }) => {
      this.drawButton.setAttribute("aria-pressed", String(id === "draw"));
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

function separator(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "separator";
  s.setAttribute("aria-hidden", "true");
  return s;
}
