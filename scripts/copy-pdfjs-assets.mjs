// Copies the data files PDF.js needs at runtime (character maps, standard
// fonts, colour profiles and image decoders) from node_modules into
// public/pdfjs, so the app can load them from its own files and never needs
// the internet. Runs automatically before `npm run dev` and `npm run build`.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "pdfjs-dist");
const target = join(root, "public", "pdfjs");

if (!existsSync(source)) {
  console.error("pdfjs-dist is not installed. Run `npm install` first.");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const folder of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
  cpSync(join(source, folder), join(target, folder), { recursive: true });
}
console.log("Copied PDF.js assets to public/pdfjs");
