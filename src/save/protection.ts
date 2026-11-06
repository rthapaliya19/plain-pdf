/**
 * Password-protected PDFs: unlocking a copy with the password (so changes can
 * be written into it), and locking the new copy again exactly like the
 * original (same password, same "no changes allowed" marks, same owner
 * password). Uses qpdf (Apache 2.0), compiled to run inside the app; it's
 * loaded only when such a file is saved or printed. Nothing leaves the device.
 */
import wasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";

/** qpdf couldn't unlock or lock the file (for example an unusual kind of protection). */
export class ProtectionError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ProtectionError";
  }
}

interface QpdfFs {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
}

/** Runs qpdf once, on files in its own private memory, and returns /out.pdf. */
async function qpdf(files: Record<string, Uint8Array>, args: string[]): Promise<Uint8Array> {
  let messages: string[] = [];
  try {
    const { default: createModule } = await import("@neslinesli93/qpdf-wasm");
    const q = await createModule({ locateFile: () => wasmUrl });
    const fs = q.FS as unknown as QpdfFs;
    for (const [path, data] of Object.entries(files)) fs.writeFile(path, data);
    // qpdf writes its messages straight to the console: keep them for the error instead.
    const { log, warn, error } = console;
    const keep = (...parts: unknown[]) => void messages.push(parts.join(" "));
    console.log = console.warn = console.error = keep;
    let code: number;
    try {
      code = q.callMain(args);
    } catch (e) {
      code = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 2;
    } finally {
      Object.assign(console, { log, warn, error });
    }
    // 0: done. 3: done, after working around small problems in the file.
    if (code !== 0 && code !== 3) throw new ProtectionError(messages.join("\n") || `qpdf stopped (${code})`);
    return fs.readFile("/out.pdf");
  } catch (e) {
    if (e instanceof ProtectionError) throw e;
    throw new ProtectionError(e instanceof Error ? e.message : String(e));
  } finally {
    messages = [];
  }
}

/** The file without its lock, opened with `password` ("" for files that only have "no changes" marks). */
export function unlock(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  return qpdf({ "/in.pdf": bytes }, [`--password=${password}`, "--decrypt", "/in.pdf", "/out.pdf"]);
}

/** `bytes` locked exactly like `original` (which opens with `password`). */
export function lockLike(original: Uint8Array, password: string, bytes: Uint8Array): Promise<Uint8Array> {
  return qpdf({ "/original.pdf": original, "/in.pdf": bytes }, [
    "--copy-encryption=/original.pdf",
    `--encryption-file-password=${password}`,
    // Some older files use old, weak locks; the copy keeps the same kind.
    "--allow-weak-crypto",
    "/in.pdf",
    "/out.pdf",
  ]);
}
