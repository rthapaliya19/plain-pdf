import { defineConfig, type Plugin } from "vite";

/**
 * The privacy lock. In the built app, the browser is told to block every
 * connection except loading the app's own files: no uploads, no tracking,
 * no outside fonts or scripts. Only applied to builds, because the
 * development server needs a live connection for instant reloads.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "manifest-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");

/** Set by Tauri while it builds the installed apps. */
const buildingNativeApp = Boolean(
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TAURI_ENV_PLATFORM,
);

function privacyLock(): Plugin {
  return {
    name: "plain-pdf-privacy-lock",
    // The installed apps (Tauri) get the same policy from src-tauri/tauri.conf.json instead,
    // with the extra address Tauri uses to talk to the app's native part.
    apply: (_config, env) => env.command === "build" && !buildingNativeApp,
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  // Relative paths, so the same build works from any folder or web address
  // and later inside the Windows, Android and macOS apps.
  base: "./",
  plugins: [privacyLock()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
