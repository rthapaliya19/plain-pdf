/**
 * The Text tool's small options strip: three sizes, three colours, Done.
 * Choices apply to the text being typed and to new text, and are remembered
 * on this device.
 */
import { icons } from "../../ui/icons";
import { PEN_COLORS } from "../draw/settings";

export const TEXT_SIZES = [
  { name: "Small", points: 10 },
  { name: "Medium", points: 13 },
  { name: "Large", points: 18 },
] as const;

export interface TextSettings {
  size: number;
  color: string;
}

const STORAGE_KEY = "plain-pdf:text-settings";

export function loadTextSettings(): TextSettings {
  const fallback = { size: TEXT_SIZES[1].points, color: PEN_COLORS[0].value };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<TextSettings> | null;
    if (!saved) return fallback;
    return {
      size: TEXT_SIZES.some((s) => s.points === saved.size) ? saved.size! : fallback.size,
      color: PEN_COLORS.some((c) => c.value === saved.color) ? saved.color! : fallback.color,
    };
  } catch {
    return fallback;
  }
}

function saveTextSettings(settings: TextSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings just aren't remembered.
  }
}

export class TextOptions {
  readonly element: HTMLDivElement;
  private settings: TextSettings;
  private readonly sizeButtons: HTMLButtonElement[] = [];
  private readonly colorButtons: HTMLButtonElement[] = [];

  constructor(initial: TextSettings, onChange: (s: TextSettings) => void, onDone: () => void) {
    this.settings = { ...initial };
    this.element = document.createElement("div");
    this.element.className = "draw-options text-options";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "Text options");
    this.element.hidden = true;
    // Tapping the strip shouldn't take the typing focus away from the text box.
    this.element.addEventListener("mousedown", (e) => e.preventDefault());

    const change = (patch: Partial<TextSettings>) => {
      this.settings = { ...this.settings, ...patch };
      saveTextSettings(this.settings);
      this.refresh();
      onChange({ ...this.settings });
    };

    const sizes = group();
    TEXT_SIZES.forEach((size, i) => {
      const b = option(`${size.name} text`);
      b.classList.add("text-size");
      const letter = document.createElement("span");
      letter.textContent = "A";
      letter.style.fontSize = `${12 + i * 4}px`;
      b.append(letter);
      b.addEventListener("click", () => change({ size: size.points }));
      this.sizeButtons.push(b);
      sizes.append(b);
    });

    const colors = group();
    for (const color of PEN_COLORS) {
      const b = option(`${color.name} text`);
      b.classList.add("swatch");
      b.style.setProperty("--swatch", color.value);
      b.addEventListener("click", () => change({ color: color.value }));
      this.colorButtons.push(b);
      colors.append(b);
    }

    const done = document.createElement("button");
    done.type = "button";
    done.className = "done-button";
    done.title = "Stop adding text (Esc)";
    done.innerHTML = icons.check;
    done.append("Done");
    done.addEventListener("click", () => onDone());
    const doneGroup = group();
    doneGroup.append(done);

    this.element.append(sizes, colors, doneGroup);
    this.refresh();
  }

  get current(): TextSettings {
    return { ...this.settings };
  }

  /** Shows the size and colour of the text being edited. */
  reflect(settings: TextSettings): void {
    this.settings = { ...settings };
    this.refresh();
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  private refresh(): void {
    TEXT_SIZES.forEach((s, i) => this.sizeButtons[i].setAttribute("aria-pressed", String(s.points === this.settings.size)));
    PEN_COLORS.forEach((c, i) => this.colorButtons[i].setAttribute("aria-pressed", String(c.value === this.settings.color)));
  }
}

function option(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "option";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", "false");
  return b;
}

function group(): HTMLDivElement {
  const g = document.createElement("div");
  g.className = "option-group";
  return g;
}
