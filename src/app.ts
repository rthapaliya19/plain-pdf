/**
 * Wires the app together: toolbar, viewer, start screen, opening files
 * (button, keyboard shortcut, drag and drop) and error messages.
 */
import { EventHub } from "./core/events";
import { NotAPdfError, PasswordCancelledError, openPdf, type PdfDocument } from "./core/pdf-engine";
import { askPassword, showMessage } from "./ui/dialog";
import { icons } from "./ui/icons";
import { Toolbar } from "./ui/toolbar";
import { Viewer } from "./viewer/viewer";

/** The open file. `bytes` are the untouched original, kept for saving a copy later. */
export interface OpenFile {
  name: string;
  bytes: Uint8Array;
  doc: PdfDocument;
}

export class App {
  readonly hub = new EventHub();
  private readonly viewer = new Viewer(this.hub);
  private readonly toolbar: Toolbar;
  private readonly startScreen: HTMLElement;
  private readonly busy: HTMLElement;
  private readonly dropHint: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private current: OpenFile | null = null;
  private openCounter = 0;

  constructor(root: HTMLElement) {
    this.toolbar = new Toolbar(this.hub, {
      open: () => this.chooseFile(),
      zoomIn: () => this.viewer.zoomIn(),
      zoomOut: () => this.viewer.zoomOut(),
      fitToWidth: () => this.viewer.fitToWidth(),
      goToPage: (page) => this.viewer.goToPage(page),
    });

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "application/pdf,.pdf";
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) void this.openFile(file);
    });

    this.startScreen = this.buildStartScreen();
    this.busy = overlay("busy", "Opening…");
    this.busy.hidden = true;
    this.dropHint = overlay("drop-hint", "Drop the PDF to open it");
    this.dropHint.hidden = true;

    const main = document.createElement("main");
    main.className = "main";
    main.append(this.viewer.element, this.startScreen, this.busy, this.dropHint);
    root.append(this.toolbar.element, main, this.fileInput);

    this.setUpKeyboard();
    this.setUpDragAndDrop();
  }

  /** The currently open file, if any. */
  get openFileInfo(): OpenFile | null {
    return this.current;
  }

  chooseFile(): void {
    this.fileInput.click();
  }

  async openFile(file: File): Promise<void> {
    const ticket = ++this.openCounter;
    this.busy.querySelector("p")!.textContent = `Opening ${file.name}…`;
    this.busy.hidden = false;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await openPdf(bytes, askPassword);
      if (ticket !== this.openCounter) {
        // Another file was opened while this one was loading.
        await doc.close();
        return;
      }
      const previous = this.current;
      this.current = { name: file.name, bytes, doc };
      this.viewer.show(doc);
      this.startScreen.hidden = true;
      document.title = `${file.name} - Plain PDF`;
      this.hub.emit("document:opened", { name: file.name, pageCount: doc.pageCount });
      await previous?.doc.close();
    } catch (error) {
      if (error instanceof PasswordCancelledError) return;
      if (error instanceof NotAPdfError) {
        await showMessage("Can't open this file", error.message);
      } else {
        console.error(error);
        await showMessage("Can't open this file", "Something went wrong while opening this PDF. It may be damaged.");
      }
    } finally {
      if (ticket === this.openCounter) this.busy.hidden = true;
    }
  }

  private buildStartScreen(): HTMLElement {
    const screen = document.createElement("section");
    screen.className = "start-screen";
    const card = document.createElement("div");
    card.className = "start-card";

    const logo = document.createElement("div");
    logo.className = "start-logo";
    logo.innerHTML = icons.file;
    const title = document.createElement("h1");
    title.textContent = "Plain PDF";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "button primary big";
    open.textContent = "Open a PDF";
    open.addEventListener("click", () => this.chooseFile());

    const hint = document.createElement("p");
    hint.className = "hint drag-only";
    hint.textContent = "or drag a PDF into this window";

    const privacy = document.createElement("p");
    privacy.className = "privacy";
    privacy.innerHTML = icons.lock;
    privacy.append(" Your files stay on this device. Nothing is uploaded.");

    card.append(logo, title, open, hint, privacy);
    screen.append(card);
    return screen;
  }

  private setUpKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "o") {
        event.preventDefault();
        this.chooseFile();
      } else if (key === "=" || key === "+") {
        event.preventDefault();
        this.viewer.zoomIn();
      } else if (key === "-" || key === "_") {
        event.preventDefault();
        this.viewer.zoomOut();
      } else if (key === "0") {
        event.preventDefault();
        this.viewer.fitToWidth();
      }
    });
  }

  private setUpDragAndDrop(): void {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    window.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      this.dropHint.hidden = false;
    });
    window.addEventListener("dragleave", (event) => {
      // relatedTarget is null when the pointer leaves the window.
      if (event.relatedTarget === null) this.dropHint.hidden = true;
    });
    window.addEventListener("drop", (event) => {
      event.preventDefault();
      this.dropHint.hidden = true;
      const file = event.dataTransfer?.files[0];
      if (file) void this.openFile(file);
    });
  }
}

function overlay(className: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `overlay ${className}`;
  const p = document.createElement("p");
  p.textContent = text;
  el.append(p);
  return el;
}
