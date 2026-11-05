// Prepares the Android project that `tauri android init` generates:
// - lets Plain PDF appear in "Open with" and the Share menu for PDFs
// - replaces the main screen with android/MainActivity.kt (receives those PDFs)
// Run after `npx tauri android init --ci` (the build workflow does this).
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "src-tauri", "gen", "android", "app", "src", "main");

const manifestPath = join(app, "AndroidManifest.xml");
let manifest = readFileSync(manifestPath, "utf8");
const filters = `
            <!-- Plain PDF: open PDFs from other apps ("Open with" and Share). -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="content" android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="file" android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
`;
if (!manifest.includes("Plain PDF: open PDFs")) {
  const end = manifest.indexOf("</activity>");
  if (end < 0) throw new Error("No <activity> in AndroidManifest.xml");
  manifest = manifest.slice(0, end) + filters + "        " + manifest.slice(end);
  writeFileSync(manifestPath, manifest);
}

const activity = join(app, "java", "io", "github", "rthapaliya19", "plainpdf", "MainActivity.kt");
copyFileSync(join(root, "android", "MainActivity.kt"), activity);
console.log("Android project prepared for opening PDFs.");
