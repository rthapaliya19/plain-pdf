/** Pen colours, highlighter colour and thicknesses, and remembering the last choice. */

export type DrawMode = "pen" | "highlighter" | "eraser";
export type SizeIndex = 0 | 1 | 2;

export const PEN_COLORS = [
  { name: "Black", value: "#1a1a1a" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Red", value: "#dc2626" },
] as const;

export const HIGHLIGHTER_COLOR = "#ffe34a";

/** Pen thickness in PDF points for thin, medium and thick. */
export const PEN_SIZES = [1, 2, 3.5] as const;

/**
 * Thickness of the straight highlighter line used where there's no
 * readable text (scans). Over text, highlights follow the text's height.
 */
export const HIGHLIGHTER_LINE_WIDTH = 14;

export const SIZE_NAMES = ["Thin", "Medium", "Thick"] as const;

export interface DrawSettings {
  mode: DrawMode;
  penColor: string;
  size: SizeIndex;
}

const STORAGE_KEY = "plain-pdf:draw-settings";
const DEFAULTS: DrawSettings = { mode: "pen", penColor: PEN_COLORS[0].value, size: 1 };

/** Last used settings on this device (a convenience only; never required). */
export function loadSettings(): DrawSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<DrawSettings> | null;
    if (!saved) return { ...DEFAULTS };
    const mode = saved.mode === "highlighter" || saved.mode === "eraser" ? saved.mode : "pen";
    const penColor = PEN_COLORS.some((c) => c.value === saved.penColor) ? saved.penColor! : DEFAULTS.penColor;
    const size = saved.size === 0 || saved.size === 2 ? saved.size : 1;
    return { mode, penColor, size };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: DrawSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private window, blocked site data). That's fine.
  }
}
