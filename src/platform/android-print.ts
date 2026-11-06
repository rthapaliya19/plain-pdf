/**
 * Printing in the Android app. The app's screen can't print by itself, so the
 * finished PDF is handed to Android's own print screen (printers, "Save as
 * PDF") through `window.PlainPdfPrinter`, which android/MainActivity.kt adds.
 * The file stays on the phone; nothing is sent anywhere by the app.
 */

interface AndroidPrinter {
  begin(): boolean;
  add(base64: string): boolean;
  print(name: string): boolean;
}

/** About 0.75 MB of the file per piece (a multiple of 3, so each piece is whole base64). */
const PIECE = 3 * 256 * 1024;

function printer(): AndroidPrinter | null {
  return (window as unknown as { PlainPdfPrinter?: AndroidPrinter }).PlainPdfPrinter ?? null;
}

/** True when Android's print screen is available (the Android app). */
export function canPrintWithAndroid(): boolean {
  return printer() !== null;
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Opens Android's print screen for this PDF, named `name` (used by "Save as PDF"). */
export function printWithAndroid(bytes: Uint8Array, name: string): void {
  const p = printer();
  if (!p) throw new Error("Android's print screen isn't available.");
  if (!p.begin()) throw new Error("Couldn't start printing.");
  for (let i = 0; i < bytes.length; i += PIECE) {
    if (!p.add(toBase64(bytes.subarray(i, i + PIECE)))) throw new Error("Couldn't prepare the printout.");
  }
  if (!p.print(name)) throw new Error("Couldn't open the print screen.");
}
