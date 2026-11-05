/**
 * Wires the app together: toolbar, viewer, start screen, opening files
 * (button, keyboard shortcut, drag and drop) and error messages.
 */
import { Additions } from "./core/additions";
import { EventHub } from "./core/events";
import { History } from "./core/history";
import { NotAPdfError, PasswordCancelledError, openPdf, type PdfDocument } from "./core/pdf-engine";
import { TextLayoutCache } from "./core/text-layout";
import { ToolManager } from "./core/tools";
import { OverlayRenderer } from "./overlay/overlay-renderer";
import { DrawTool } from "./tools/draw/draw-tool";
import { SignatureController } from "./tools/sign/signature-controller";
import { chooseSaveTarget, editedName } from "./save/save-file";
import { askConfirm, askPassword, showMessage } from "./ui/dialog";
import { showToast } from "./ui/toast";
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
  /** What the person added on top of the PDF, with undo/redo. */
  private readonly additions = new Additions(this.hub);
  private readonly history = new History(this.hub);
  private readonly tools = new ToolManager(this.hub);
  private readonly toolbar: Toolbar;
  private readonly startScreen: HTMLElement;
  private readonly busy: HTMLElement;
  private readonly dropHint: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private current: OpenFile | null = null;
  /** Changes made since the file was opened or last saved. */
  private dirty = false;
  private saving = false;
  /** Where the text sits on each page of the open file (for the highlighter). */
  private textLayout: TextLayoutCache | null = null;
  private openCounter = 0;

  constructor(root: HTMLElement) {
    const renderer = new OverlayRenderer(this.viewer, this.additions, this.hub);
    const drawTool = new DrawTool(this.viewer, this.additions, this.history, renderer, () => this.textLayout, () =>
      this.tools.deactivate(),
    );
    this.tools.register(drawTool);
    const signatures = new SignatureController(this.viewer, this.additions, this.history, renderer, this.hub);

    this.toolbar = new Toolbar(this.hub, {
      open: () => this.chooseFile(),
      toggleDraw: () => this.tools.toggle("draw"),
      save: () => void this.save(),
      sign: () => {
        this.tools.deactivate();
        void signatures.start();
      },
      undo: () => this.history.undo(),
      redo: () => this.history.redo(),
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
    main.append(this.viewer.element, drawTool.options.element, this.startScreen, this.busy, this.dropHint);
    root.append(this.toolbar.element, main, this.fileInput);

    this.setUpKeyboard();
    this.setUpDragAndDrop();

    // Warn before closing or reloading the window with unsaved drawings.
    window.addEventListener("beforeunload", (event) => {
      if (this.hasUnsavedChanges) event.preventDefault();
    });

    this.hub.on("additions:changed", () => {
      this.dirty = true;
      this.toolbar.setSaveEnabled(this.additions.size > 0);
    });
  }

  private get hasUnsavedChanges(): boolean {
    return this.dirty && this.additions.size > 0;
  }

  /** The currently open file, if any. */
  get openFileInfo(): OpenFile | null {
    return this.current;
  }

  chooseFile(): void {
    this.fileInput.click();
  }

  async openFile(file: File): Promise<void> {
    if (this.current && this.hasUnsavedChanges) {
      const discard = await askConfirm(
        "Discard your changes?",
        `Your changes to "${this.current.name}" haven't been saved. Opening another file will discard them.`,
        "Discard and open",
        "Keep editing",
      );
      if (!discard) return;
    }
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
      this.textLayout = new TextLayoutCache((page) => doc.textFragments(page));
      this.tools.deactivate();
      this.additions.clear();
      this.history.clear();
      this.dirty = false;
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

  /**
   * Saves a copy of the PDF with everything added locked into the pages.
   * The original file is never changed.
   */
  async save(): Promise<void> {
    const file = this.current;
    if (!file || this.saving) return;
    if (this.additions.size === 0) {
      showToast("Nothing to save yet. Draw, highlight or sign first.");
      return;
    }
    if (file.doc.encrypted) {
      await showMessage(
        "Can't save this file yet",
        "This PDF is encrypted (password-protected), so Plain PDF can't save a copy with changes yet. Your changes are still here.",
      );
      return;
    }
    this.tools.deactivate();
    // Ask where to save first, while the click still counts as the person's choice.
    const target = await chooseSaveTarget(editedName(file.name));
    if (!target) return;
    this.saving = true;
    this.busy.querySelector("p")!.textContent = "Saving a copy…";
    this.busy.hidden = false;
    try {
      // The saving code (pdf-lib) is only loaded the first time you save.
      const { saveWithAdditions } = await import("./save/save-pdf");
      const bytes = await saveWithAdditions(file.bytes, this.additions.all(), file.doc.pageToPdf);
      await target.write(bytes);
      if (this.current === file) this.dirty = false;
      showToast(
        target.kind === "file" ? `Saved a copy: ${target.name}` : `Saved a copy to your Downloads: ${target.name}`,
        5000,
      );
    } catch (error) {
      console.error(error);
      await showMessage(
        "Couldn't save",
        error instanceof Error && error.name === "EncryptedPdfError"
          ? error.message
          : "Something went wrong while saving. Your original file is unchanged, and your changes are still here.",
      );
    } finally {
      this.saving = false;
      this.busy.hidden = true;
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
      if (document.querySelector("dialog[open]")) return;
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape" && !typing) {
        this.tools.deactivate();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if ((key === "z" || key === "y") && !typing) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) this.history.redo();
        else this.history.undo();
      } else if (key === "s") {
        event.preventDefault();
        void this.save();
      } else if (key === "o") {
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
