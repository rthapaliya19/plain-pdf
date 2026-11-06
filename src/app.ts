/**
 * Wires the app together: toolbar, viewer, start screen, opening files
 * (button, keyboard shortcut, drag and drop) and error messages.
 */
import { Additions } from "./core/additions";
import { EventHub } from "./core/events";
import { History } from "./core/history";
import { NotAPdfError, PasswordCancelledError, openPdf, type PdfDocument } from "./core/pdf-engine";
import { TextLayoutCache } from "./core/text-layout";
import { appendPages, deletePages, movePages, pickPages, rotatePages, samePlan, type PagesState } from "./core/page-ops";
import { firstPlan, isUnchanged, workspaceDocument, type PageEntry, type PagePlan, type Source } from "./core/workspace";
import { ToolManager } from "./core/tools";
import { OverlayRenderer } from "./overlay/overlay-renderer";
import { DrawTool } from "./tools/draw/draw-tool";
import { SignatureController } from "./tools/sign/signature-controller";
import { TextTool } from "./tools/text/text-tool";
import { RedactTool } from "./tools/redact/redact-tool";
import { printDocument, printablePictures } from "./tools/print/print";
import { Search } from "./tools/search/search";
import { OrganizeScreen } from "./tools/organize/organize-screen";
import {
  isAndroidApp,
  isNativeApp,
  openManyWithSystemDialog,
  openWithSystemDialog,
  watchSystemOpenRequests,
} from "./platform/native";
import { canPrintWithAndroid, printWithAndroid } from "./platform/android-print";
import type { RedactionOptions } from "./save/save-pdf";
import { chooseSaveTarget, editedName } from "./save/save-file";
import { askChoice, askConfirm, askPassword, showMessage } from "./ui/dialog";
import { showToast } from "./ui/toast";
import { icons } from "./ui/icons";
import { Toolbar } from "./ui/toolbar";
import { ContentsPanel } from "./ui/contents-panel";
import { Viewer } from "./viewer/viewer";

/** The open file. `bytes` are the untouched original, kept for saving a copy later. */
export interface OpenFile {
  name: string;
  bytes: Uint8Array;
  /** The page list as one document (see core/workspace.ts). */
  doc: PdfDocument;
  /** The opened file first, then any files whose pages were added. */
  sources: Source[];
  plan: PageEntry[];
}

export class App {
  readonly hub = new EventHub();
  private readonly viewer = new Viewer(this.hub);
  /** What the person added on top of the PDF, with undo/redo. */
  private readonly additions = new Additions(this.hub);
  private readonly history = new History(this.hub);
  private readonly tools = new ToolManager(this.hub);
  private readonly toolbar: Toolbar;
  private readonly search: Search;
  private readonly contents: ContentsPanel;
  private readonly organize: OrganizeScreen;
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
    const textTool = new TextTool(this.viewer, this.additions, this.history, renderer, () => this.textLayout, () =>
      this.tools.deactivate(),
    );
    this.tools.register(textTool);
    const redactTool = new RedactTool(this.viewer, this.additions, this.history, renderer, () => this.tools.deactivate());
    this.tools.register(redactTool);
    const signatures = new SignatureController(this.viewer, this.additions, this.history, renderer, this.hub, (item) => {
      this.tools.activate("text");
      textTool.edit(item);
    });

    this.toolbar = new Toolbar(this.hub, {
      open: () => this.chooseFile(),
      toggleDraw: () => this.tools.toggle("draw"),
      toggleText: () => this.tools.toggle("text"),
      save: () => void this.save(),
      search: () => this.search.open(),
      toggleContents: () => this.contents.toggle(),
      sign: () => {
        this.tools.deactivate();
        void signatures.start();
      },
      undo: () => {
        textTool.commit();
        this.history.undo();
      },
      redo: () => {
        textTool.commit();
        this.history.redo();
      },
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
    this.contents = new ContentsPanel(this.hub, {
      goTo: (index, y) => (y === null ? this.viewer.goToPage(index + 1) : this.viewer.scrollToSpot(index, y)),
      openExternal: (url) => void this.openLinkAfterAsking(url),
      changed: (available, open) => this.toolbar.setContents(available, open),
    });
    this.hub.on("document:opened", () => void this.contents.load(this.current?.doc ?? null));
    this.search = new Search(this.viewer, this.hub, () => this.current?.doc ?? null);
    this.organize = new OrganizeScreen(this.hub, {
      doc: () => this.current?.doc ?? null,
      pageKey: (i) => {
        const e = this.current?.plan[i];
        return e ? `${e.source}:${e.index}:${e.rotation}` : String(i);
      },
      rotate: (pages, by) => this.rotatePages(pages, by),
      remove: (pages) => this.deletePages(pages),
      move: (pages, before) => this.movePages(pages, before),
      addFiles: (files) => this.addPagesFromFiles(files),
      saveSelected: (pages) => this.saveSelectedPages(pages),
      undo: () => this.history.undo(),
      redo: () => this.history.redo(),
      canUndo: () => this.history.canUndo,
      canRedo: () => this.history.canRedo,
    });
    document.body.append(this.organize.element);
    this.toolbar.moreMenu.add(icons.pages, "Organize pages", "", () => {
      this.tools.deactivate();
      this.organize.open();
    });
    this.toolbar.moreMenu.add(icons.addFile, "Add pages from another PDF", "", () => {
      if (isNativeApp) void openManyWithSystemDialog().then((files) => this.addPagesFromFiles(files));
      else this.organize.chooseFilesToAdd();
    });
    this.toolbar.moreMenu.add(icons.redact, "Redact", "", () => this.tools.activate("redact"));
    // Print is in the More menu. (The Android app prints through Android's own print screen.)
    if (!isAndroidApp || canPrintWithAndroid()) {
      this.toolbar.moreMenu.add(icons.print, "Print", isAndroidApp ? "" : isMac() ? "⌘P" : "Ctrl+P", () => void this.print());
    }

    main.append(
      this.search.element,
      this.viewer.element,
      this.contents.backdrop,
      this.contents.element,
      drawTool.options.element,
      textTool.options.element,
      redactTool.options,
      this.startScreen,
      this.busy,
      this.dropHint,
    );
    root.append(this.toolbar.element, main, this.fileInput);

    this.setUpKeyboard();
    this.setUpDragAndDrop();

    // In the installed app: open the PDF the system asks for (double-click, "Open with").
    if (isNativeApp) {
      void watchSystemOpenRequests((file) => void this.openFile(file)).catch((error: unknown) => console.error(error));
    }

    // Warn before closing or reloading the window with unsaved drawings.
    window.addEventListener("beforeunload", (event) => {
      if (this.hasUnsavedChanges) event.preventDefault();
    });

    this.hub.on("additions:changed", () => {
      this.dirty = true;
      this.toolbar.setSaveEnabled(this.hasChanges);
    });

    this.viewer.setLinkHandler({
      goToPage: (index) => this.viewer.goToPage(index + 1),
      openExternal: (url) => void this.openLinkAfterAsking(url),
    });
  }

  /** Web links (in the PDF or its chapter list) open in the browser only after asking. */
  private async openLinkAfterAsking(url: string): Promise<void> {
    const open = await askConfirm("Open this link in your browser?", url, "Open link", "Cancel");
    if (open) window.open(url, "_blank", "noopener,noreferrer");
  }

  /** Something was added or a form was filled in. */
  private get hasChanges(): boolean {
    const file = this.current;
    if (!file) return false;
    return this.additions.size > 0 || file.doc.formsModified || !isUnchanged(file.sources, file.plan);
  }

  private get hasUnsavedChanges(): boolean {
    return this.dirty && this.hasChanges;
  }

  /** The currently open file, if any. */
  get openFileInfo(): OpenFile | null {
    return this.current;
  }

  chooseFile(): void {
    if (isNativeApp) {
      openWithSystemDialog()
        .then((file) => file && this.openFile(file))
        .catch((error: unknown) => console.error(error));
      return;
    }
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
      const base = await openPdf(bytes, askPassword);
      if (ticket !== this.openCounter) {
        // Another file was opened while this one was loading.
        await base.close();
        return;
      }
      const previous = this.current;
      this.organize.close();
      const sources: Source[] = [{ name: file.name, bytes, doc: base }];
      const plan = firstPlan(base);
      const doc = workspaceDocument(sources, plan);
      this.current = { name: file.name, bytes, doc, sources, plan };
      this.textLayout = new TextLayoutCache((page) => doc.textFragments(page));
      this.tools.deactivate();
      this.additions.clear();
      this.history.clear();
      this.dirty = false;
      this.watchForms(base);
      this.viewer.show(doc);
      this.toolbar.setSaveEnabled(false);
      if (doc.isXfaForm) {
        showToast("This form uses an older Adobe format (XFA) that Plain PDF can't fill in.", 7000);
      }
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
    if (!this.hasChanges) {
      showToast("Nothing to save yet. Draw, type, highlight, sign or fill in a form first.");
      return;
    }
    this.tools.deactivate();
    const protection = await this.chooseProtection(file);
    if (!protection) return;
    // Ask where to save first, while the click still counts as the person's choice.
    const target = await chooseSaveTarget(editedName(file.name));
    if (!target) return;
    this.saving = true;
    this.busy.querySelector("p")!.textContent = "Saving a copy…";
    this.busy.hidden = false;
    try {
      const pictured: number[] = [];
      const bytes = await this.buildCopy(file, this.pagesState(file), protection, pictured);
      await target.write(bytes);
      if (this.current === file) this.dirty = false;
      const where = target.kind === "file" ? `Saved a copy: ${target.name}` : `Saved a copy to your Downloads: ${target.name}`;
      showToast(
        (file.doc.passwordProtected && protection === "keep" ? `${where} (same password)` : where) + picturedNote(pictured),
        pictured.length ? 9000 : 5000,
      );
    } catch (error) {
      console.error(error);
      await showMessage("Couldn't save", saveProblem(error, "Something went wrong while saving."));
    } finally {
      this.saving = false;
      this.busy.hidden = true;
    }
  }

  /**
   * A copy of the open file with everything added (and form answers) locked in.
   * If the opened file is password-protected or marked "no changes allowed",
   * `protection` says whether the copy is locked the same way ("keep") or not.
   */
  private async buildCopy(
    file: OpenFile,
    state: PagesState = this.pagesState(file),
    protection: Protection = "remove",
    /** Filled with pages that had to be saved as pictures for redaction. */
    pictured: number[] = [],
  ): Promise<Uint8Array> {
    // The saving code (pdf-lib) is only loaded the first time it's needed.
    const { saveWithAdditions, saveWorkspace } = await import("./save/save-pdf");
    const redaction = this.redactionHelpers(file, state.plan, pictured);
    let bytes: Uint8Array;
    if (isUnchanged(file.sources, state.plan)) {
      const base = await this.unlockedBytes(file.sources[0]);
      bytes = await saveWithAdditions(base, state.additions, file.doc.pageToPdf, { lockForms: file.doc.formsModified, ...redaction });
    } else {
      // Pages were reorganized or added: build a new file from the page list.
      const sources = await Promise.all(file.sources.map(async (s) => ({ bytes: await this.unlockedBytes(s) })));
      const placed = workspaceDocument(file.sources, state.plan);
      bytes = await saveWorkspace(sources, state.plan, state.additions, placed.pageToPdf, redaction);
    }
    return this.protect(file, bytes, protection);
  }

  /**
   * For redaction: pictures of pages whose content can't be changed safely
   * (drawn as shown, with the boxes painted in), and a list of those pages.
   */
  private redactionHelpers(file: OpenFile, plan: PagePlan, pictured: number[]): RedactionOptions {
    return {
      pagePicture: async (index, rects) => {
        const doc = workspaceDocument(file.sources, plan);
        const size = doc.pageSizes[index];
        const ppp = Math.min(300 / 72, Math.sqrt(12_000_000 / (size.width * size.height)));
        const canvas = await doc.renderForPrint(index, ppp);
        const g = canvas.getContext("2d")!;
        const sx = canvas.width / size.width;
        const sy = canvas.height / size.height;
        for (const r of rects) {
          g.fillStyle = r.color;
          g.fillRect(Math.floor(r.x * sx), Math.floor(r.y * sy), Math.ceil(r.w * sx) + 1, Math.ceil(r.h * sy) + 1);
        }
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error("Couldn't make a picture of the page.");
        return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height };
      },
      onPicture: (index, reason) => {
        console.info(`Page ${index + 1} saved as a picture for redaction (${reason}).`);
        pictured.push(index);
      },
    };
  }

  /** A file's bytes with its form answers written in, and unlocked if it's protected. */
  private async unlockedBytes(source: Source): Promise<Uint8Array> {
    const bytes = source.doc.formsModified ? await source.doc.bytesWithFormValues() : source.bytes;
    if (!source.doc.encrypted) return bytes;
    const { unlock } = await import("./save/protection");
    return unlock(bytes, source.doc.password);
  }

  /** Locks a finished copy like the opened file, if asked to and if it was locked. */
  private async protect(file: OpenFile, bytes: Uint8Array, protection: Protection): Promise<Uint8Array> {
    const main = file.sources[0];
    if (protection !== "keep" || !main.doc.encrypted) return bytes;
    const { lockLike } = await import("./save/protection");
    return lockLike(main.bytes, main.doc.password, bytes);
  }

  /**
   * For a file that needs a password to open: asks whether the copy should
   * need the same password. Files only marked "no changes allowed" keep that
   * mark without asking. Resolves to null if cancelled.
   */
  private async chooseProtection(file: OpenFile): Promise<Protection | null> {
    const main = file.sources[0].doc;
    if (!main.encrypted) return "remove";
    if (!main.passwordProtected) return "keep";
    return askChoice<Protection>(
      "Keep the password?",
      "This PDF needs a password to open. Should the copy need the same password?",
      [
        { label: "Save without password", value: "remove" },
        { label: "Keep password", value: "keep" },
      ],
    );
  }

  // ---------- Pages: rotate, delete, move, add, save selected ----------

  private pagesState(file: OpenFile): PagesState {
    return { plan: file.plan, additions: this.additions.all() };
  }

  /** Form answers in any of the open files count as changes. */
  private watchForms(doc: PdfDocument): void {
    doc.onFormsChanged(() => {
      if (!this.current?.sources.some((s) => s.doc === doc)) return;
      this.dirty = true;
      this.toolbar.setSaveEnabled(true);
    });
  }

  /** Shows a page list (after an operation, or undoing one). */
  private showPages(file: OpenFile, state: PagesState): void {
    if (this.current !== file) return;
    this.tools.deactivate();
    const keep = this.viewer.currentPageIndex + 1;
    file.plan = state.plan;
    file.doc = workspaceDocument(file.sources, state.plan);
    const doc = file.doc;
    this.textLayout = new TextLayoutCache((page) => doc.textFragments(page));
    this.viewer.show(doc, keep);
    this.hub.emit("document:opened", { name: file.name, pageCount: doc.pageCount });
    this.additions.replaceAll(state.additions);
    this.dirty = true;
    this.toolbar.setSaveEnabled(this.hasChanges);
    this.hub.emit("pages:changed", { pageCount: doc.pageCount });
  }

  /** Runs a page operation, with undo. */
  private pageOperation(change: (state: PagesState) => PagesState): void {
    const file = this.current;
    if (!file) return;
    const before = this.pagesState(file);
    const after = change(before);
    if (samePlan(before.plan, after.plan) && before.additions.length === after.additions.length && before.additions.every((a, i) => a === after.additions[i])) return;
    this.showPages(file, after);
    this.history.record({ undo: () => this.showPages(file, before), redo: () => this.showPages(file, after) });
  }

  get pageCount(): number {
    return this.current?.doc.pageCount ?? 0;
  }

  get currentDocument(): PdfDocument | null {
    return this.current?.doc ?? null;
  }

  rotatePages(pages: number[], by: number): void {
    const sizes = this.current?.doc.pageSizes ?? [];
    this.pageOperation((s) => rotatePages(s, pages, by, sizes));
  }

  deletePages(pages: number[]): boolean {
    if (pages.length === 0 || pages.length >= this.pageCount) return false;
    this.pageOperation((s) => deletePages(s, pages));
    return true;
  }

  movePages(pages: number[], before: number): void {
    this.pageOperation((s) => movePages(s, pages, before));
  }

  /** Adds all pages of one or more PDF files to the end. */
  async addPagesFromFiles(files: File[]): Promise<void> {
    const file = this.current;
    if (!file || files.length === 0) return;
    const entries: PageEntry[] = [];
    const names: string[] = [];
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const doc = await openPdf(bytes, askPassword);
        if (this.current !== file) return void doc.close();
        file.sources.push({ name: f.name, bytes, doc });
        this.watchForms(doc);
        const source = file.sources.length - 1;
        entries.push(...doc.pageSizes.map((_, index) => ({ source, index, rotation: 0 })));
        names.push(f.name);
      } catch (error) {
        if (error instanceof PasswordCancelledError) continue;
        await showMessage(`Can't add "${f.name}"`, error instanceof NotAPdfError ? error.message : "Something went wrong while opening it.");
      }
    }
    if (entries.length === 0) return;
    this.pageOperation((s) => appendPages(s, entries));
    showToast(`Added ${entries.length} page${entries.length === 1 ? "" : "s"} from ${names.join(", ")}.`);
  }

  /** "Save selected pages as a new PDF". */
  async saveSelectedPages(pages: number[]): Promise<void> {
    const file = this.current;
    if (!file || pages.length === 0 || this.saving) return;
    const protection = await this.chooseProtection(file);
    if (!protection) return;
    const target = await chooseSaveTarget(editedName(file.name).replace(/-edited\.pdf$/, "-selected.pdf"));
    if (!target) return;
    this.saving = true;
    this.busy.querySelector("p")!.textContent = "Saving the selected pages…";
    this.busy.hidden = false;
    try {
      const picked = pickPages(this.pagesState(file), pages);
      const { saveWorkspace } = await import("./save/save-pdf");
      const sources = await Promise.all(file.sources.map(async (s) => ({ bytes: await this.unlockedBytes(s) })));
      const pictured: number[] = [];
      const built = await saveWorkspace(
        sources,
        picked.plan,
        picked.additions,
        workspaceDocument(file.sources, picked.plan).pageToPdf,
        this.redactionHelpers(file, picked.plan, pictured),
      );
      await target.write(await this.protect(file, built, protection));
      showToast(`Saved ${pages.length} page${pages.length === 1 ? "" : "s"} as ${target.name}${picturedNote(pictured)}`, pictured.length ? 9000 : 5000);
    } catch (error) {
      console.error(error);
      await showMessage("Couldn't save", saveProblem(error, "Something went wrong while saving the selected pages."));
    } finally {
      this.saving = false;
      this.busy.hidden = true;
    }
  }

  /** Prints the document as it would be saved: with your drawings, text and signatures. */
  async print(): Promise<void> {
    const file = this.current;
    if (!file || this.saving) return;
    this.tools.deactivate();
    let source = file.doc;
    let temporary: PdfDocument | null = null;
    this.saving = true;
    this.busy.hidden = false;
    const progress = (text: string) => (this.busy.querySelector("p")!.textContent = text);
    progress("Preparing to print…");
    try {
      if (canPrintWithAndroid()) {
        await this.printWithAndroid(file, progress);
        return;
      }
      if (this.additions.size > 0) {
        const copy = await this.printableCopy(file);
        if (copy === "cancel") return;
        if (copy) {
          temporary = await openPdf(copy, askPassword);
          source = temporary;
        }
      }
      await printDocument(source, (page, total) => progress(`Preparing page ${page} of ${total} for printing…`));
    } catch (error) {
      console.error(error);
      await showMessage("Couldn't print", "Something went wrong while preparing the pages for printing.");
    } finally {
      this.saving = false;
      this.busy.hidden = true;
      await temporary?.close();
    }
  }

  /**
   * Android: hands Android's print screen the same file Save would make (sharp
   * text). Password-protected files are handed over unlocked (Android's print
   * screen can't open locked ones); the copy is deleted once it closes.
   */
  private async printWithAndroid(file: OpenFile, progress: (text: string) => void): Promise<void> {
    let bytes: Uint8Array;
    let name = this.hasChanges ? editedName(file.name) : file.name;
    if (file.doc.encrypted) {
      const copy = await this.printableCopy(file);
      if (copy === "cancel") return;
      if (copy) {
        bytes = copy;
      } else {
        // Couldn't unlock it: print pictures of the pages as shown, without the changes.
        bytes = await printablePictures(file.doc, (page, total) => progress(`Preparing page ${page} of ${total} for printing…`));
        name = file.name;
      }
    } else if (this.hasChanges) {
      bytes = await this.buildCopy(file);
    } else {
      bytes = file.bytes;
    }
    progress("Opening the print screen…");
    printWithAndroid(bytes, name);
  }

  /**
   * An unlocked copy with the changes, for printing. If a protected file can't
   * be unlocked (an unusual kind of protection), asks whether to print without
   * the changes: resolves to null for "yes", or "cancel".
   */
  private async printableCopy(file: OpenFile): Promise<Uint8Array | null | "cancel"> {
    try {
      return await this.buildCopy(file);
    } catch (error) {
      const { ProtectionError } = await import("./save/protection");
      if (!(error instanceof ProtectionError)) throw error;
      console.warn(error);
      if (this.additions.size === 0) return null;
      this.busy.hidden = true;
      const go = await askConfirm(
        "Print without your changes?",
        "Plain PDF couldn't unlock this protected PDF to add your changes to the printout.",
        "Print without changes",
        "Cancel",
      );
      if (!go) return "cancel";
      this.busy.hidden = false;
      return null;
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
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement;
      if (event.key === "Escape" && !typing) {
        if (this.contents.closeIfCovering()) return;
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
      } else if (key === "f" && this.current) {
        event.preventDefault();
        this.search.open();
      } else if (key === "p" && this.current) {
        event.preventDefault();
        void this.print();
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

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function overlay(className: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `overlay ${className}`;
  const p = document.createElement("p");
  p.textContent = text;
  el.append(p);
  return el;
}

/** Whether a copy of a protected file is locked the same way ("keep") or saved without the lock ("remove"). */
type Protection = "keep" | "remove";

/** A message for a failed save: protected files that couldn't be unlocked get their own explanation. */
function saveProblem(error: unknown, general: string): string {
  if (error instanceof Error && (error.name === "ProtectionError" || error.name === "EncryptedPdfError")) {
    return "Plain PDF couldn't unlock this protected PDF to add your changes (it may use an unusual kind of protection). Your original file is unchanged, and your changes are still here.";
  }
  return `${general} Your original file is unchanged, and your changes are still here.`;
}

/** " Page 3 was saved as a picture..." when redaction needed it. */
function picturedNote(pages: number[]): string {
  if (pages.length === 0) return "";
  const list = pages.map((p) => p + 1).join(", ");
  return `. Page${pages.length === 1 ? "" : "s"} ${list} ${pages.length === 1 ? "was" : "were"} saved as a picture, to be sure everything under the black boxes is removed.`;
}

