/**
 * Remembers your signature and your initials on this device only (the
 * browser's private storage for this app; later, the installed app's
 * private storage). They are never uploaded or synced anywhere.
 */
import type { SignatureInk } from "../../core/additions";

export type InkKind = "signature" | "initials";

const STORAGE_KEYS: Record<InkKind, string> = {
  signature: "plain-pdf:signature",
  initials: "plain-pdf:initials",
};

/** Blue ink, like a ballpoint pen. */
export const SIGNATURE_COLOR = "#1e40af";

export function loadInk(kind: InkKind): SignatureInk | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[kind]);
    if (!raw) return null;
    const data = JSON.parse(raw) as { v?: number; ink?: SignatureInk };
    const ink = data?.ink;
    if (data?.v !== 1 || !ink || !Array.isArray(ink.strokes) || !(ink.width > 0) || !(ink.height > 0)) return null;
    return ink;
  } catch {
    return null;
  }
}

/** Returns false if this device won't let the app store it (for example a private window). */
export function saveInk(kind: InkKind, ink: SignatureInk): boolean {
  try {
    localStorage.setItem(STORAGE_KEYS[kind], JSON.stringify({ v: 1, ink }));
    return true;
  } catch {
    return false;
  }
}

export function forgetInk(kind: InkKind): void {
  try {
    localStorage.removeItem(STORAGE_KEYS[kind]);
  } catch {
    // Nothing stored, or storage unavailable: either way it's gone.
  }
}
