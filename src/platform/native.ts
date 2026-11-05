/**
 * When Plain PDF runs as an installed app (Tauri) instead of in a browser:
 * the system's own Open and Save windows, and PDFs the system asks the app
 * to open (double-click, "Open with"). The Tauri code is only loaded inside
 * the installed app, so the web preview stays small.
 */

export const isNativeApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const fileName = (path: string) => decodeURIComponent(path.split(/[\\/]/).pop() || "document.pdf");

async function readAsFile(path: string): Promise<File> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  return new File([bytes as BlobPart], fileName(path), { type: "application/pdf" });
}

/** The system's Open window. Resolves to null if cancelled. */
export async function openWithSystemDialog(): Promise<File | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, filters: [{ name: "PDF document", extensions: ["pdf"] }] });
  return typeof path === "string" ? readAsFile(path) : null;
}

/** The system's Open window, choosing one or more PDFs (for adding pages). */
export async function openManyWithSystemDialog(): Promise<File[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const paths = await open({ multiple: true, directory: false, filters: [{ name: "PDF document", extensions: ["pdf"] }] });
  const list = Array.isArray(paths) ? paths : typeof paths === "string" ? [paths] : [];
  return Promise.all(list.map(readAsFile));
}

/** The system's Save window. Resolves to where to write, or null if cancelled. */
export async function saveWithSystemDialog(suggestedName: string): Promise<{ name: string; write(bytes: Uint8Array): Promise<void> } | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: suggestedName, filters: [{ name: "PDF document", extensions: ["pdf"] }] });
  if (!path) return null;
  return {
    name: fileName(path),
    async write(bytes) {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
    },
  };
}

/** Calls `open` with each PDF the system asks the app to open: at start-up, and later (macOS). */
export async function watchSystemOpenRequests(open: (file: File) => void): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const take = async () => {
    const paths = await invoke<string[]>("take_opened_files");
    // Open the first one; if several were chosen at once, the others are ignored.
    if (paths.length > 0) open(await readAsFile(paths[0]));
  };
  await listen("files-opened", () => void take());
  // Android hands over files when the app comes back to the front.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void take();
  });
  await take();
}
