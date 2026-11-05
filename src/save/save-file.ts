/**
 * Hands the saved copy to the person.
 *
 * Where the browser allows it (Chrome on Windows and Mac), a normal "Save as"
 * window opens with the name filled in, so you can pick the folder. Otherwise
 * (Chrome on Android, Safari) the copy goes straight to the Downloads folder.
 * The installed apps (Phase 5) will use their own Save window everywhere.
 */

import { isNativeApp, saveWithSystemDialog } from "../platform/native";

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface WritableFile {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface SaveFileHandle {
  name: string;
  createWritable(): Promise<WritableFile>;
}
type WindowWithPicker = Window & { showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<SaveFileHandle> };

export type SaveTarget =
  | { kind: "file"; name: string; write(bytes: Uint8Array): Promise<void> }
  | { kind: "download"; name: string; write(bytes: Uint8Array): Promise<void> };

/** The suggested name for a copy: "lease.pdf" becomes "lease-edited.pdf". */
export function editedName(original: string): string {
  const base = original.replace(/\.pdf$/i, "");
  return base.endsWith("-edited") ? `${base}.pdf` : `${base}-edited.pdf`;
}

/**
 * Asks where to save (when the browser supports it). Resolves to null if
 * the person cancels. Must be called straight from a click or key press.
 */
export async function chooseSaveTarget(suggestedName: string): Promise<SaveTarget | null> {
  if (isNativeApp) {
    // The installed app uses the system's own Save window everywhere.
    const target = await saveWithSystemDialog(suggestedName);
    return target ? { kind: "file", ...target } : null;
  }
  const picker = (window as WindowWithPicker).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName,
        types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
      });
      return {
        kind: "file",
        name: handle.name,
        async write(bytes) {
          const file = await handle.createWritable();
          await file.write(new Blob([bytes as BlobPart], { type: "application/pdf" }));
          await file.close();
        },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      // Anything else (for example the window is blocked): fall back to Downloads.
    }
  }
  return {
    kind: "download",
    name: suggestedName,
    async write(bytes) {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = suggestedName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}
