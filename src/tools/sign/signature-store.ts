/**
 * Remembers your signature on this device only (the browser's private
 * storage for this app; later, the installed app's private storage).
 * It is never uploaded or synced anywhere.
 */
import type { SignatureInk } from "../../core/additions";

const STORAGE_KEY = "plain-pdf:signature";

/** Blue ink, like a ballpoint pen. */
export const SIGNATURE_COLOR = "#1e40af";

export function loadSignature(): SignatureInk | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
export function saveSignature(ink: SignatureInk): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ink }));
    return true;
  } catch {
    return false;
  }
}

export function forgetSignature(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, or storage unavailable: either way it's gone.
  }
}
