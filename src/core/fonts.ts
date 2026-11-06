/**
 * The three font looks used to match edited text: plain (Arimo on screen,
 * Helvetica in saved PDFs), serif (Tinos / Times) and typewriter (Cousine /
 * Courier). Each screen font has the same letter widths as its PDF font, so
 * text wraps and lines up the same on screen and in the saved file.
 */
export type FontFamily = "sans" | "serif" | "mono";

export interface FontStyle {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

export const SCREEN_FONT: Record<FontFamily, string> = {
  sans: "Arimo, Arial, Helvetica, sans-serif",
  serif: "Tinos, 'Times New Roman', Times, serif",
  mono: "Cousine, 'Courier New', Courier, monospace",
};

/** Height above and below the baseline, as fractions of the font size. */
export const FONT_METRICS: Record<FontFamily, { ascent: number; descent: number }> = {
  sans: { ascent: 0.905, descent: 0.212 },
  serif: { ascent: 0.891, descent: 0.216 },
  mono: { ascent: 0.833, descent: 0.3 },
};

/** A CSS font string, for measuring with a canvas. */
export function cssFont(style: FontStyle, size: number): string {
  return `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${size}px ${SCREEN_FONT[style.family]}`;
}

/** Makes sure the screen font is ready before measuring. */
export async function loadFont(style: FontStyle): Promise<void> {
  try {
    await document.fonts?.load(cssFont(style, 16));
  } catch {
    // Measuring falls back to a similar font.
  }
}

let ctx: CanvasRenderingContext2D | null = null;

export function measure(text: string, style: FontStyle, size: number): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * size * 0.5;
  ctx.font = cssFont(style, size);
  return ctx.measureText(text).width;
}

/** Breaks text into lines no wider than `width` (points), keeping line breaks typed with Enter. */
export function wrapText(text: string, width: number, style: FontStyle, size: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/ +/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate, style, size) > width) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}
