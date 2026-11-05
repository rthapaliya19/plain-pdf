/**
 * The small strip of drawing options shown while Draw is on:
 * three pen colours, the highlighter, the eraser, three thicknesses (only
 * for the pen; the highlighter hugs the text, so it needs none) and Done.
 */
import { icons } from "../../ui/icons";
import {
  HIGHLIGHTER_COLOR,
  PEN_COLORS,
  SIZE_NAMES,
  type DrawSettings,
  type SizeIndex,
} from "./settings";

export class DrawOptions {
  readonly element: HTMLDivElement;
  private readonly colorButtons: HTMLButtonElement[] = [];
  private readonly highlighterButton: HTMLButtonElement;
  private readonly sizeButtons: HTMLButtonElement[] = [];
  private readonly eraserButton: HTMLButtonElement;
  private readonly sizeGroup: HTMLDivElement;
  private settings: DrawSettings;

  constructor(initial: DrawSettings, onChange: (settings: DrawSettings) => void, onDone: () => void) {
    this.settings = { ...initial };
    this.element = document.createElement("div");
    this.element.className = "draw-options";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "Drawing options");
    this.element.hidden = true;

    const change = (patch: Partial<DrawSettings>) => {
      this.settings = { ...this.settings, ...patch };
      this.refresh();
      onChange({ ...this.settings });
    };

    for (const color of PEN_COLORS) {
      const b = optionButton(`${color.name} pen`);
      b.classList.add("swatch");
      b.style.setProperty("--swatch", color.value);
      b.addEventListener("click", () => change({ mode: "pen", penColor: color.value }));
      this.colorButtons.push(b);
    }

    this.highlighterButton = optionButton("Yellow highlighter");
    this.highlighterButton.classList.add("swatch", "highlighter");
    this.highlighterButton.style.setProperty("--swatch", HIGHLIGHTER_COLOR);
    this.highlighterButton.innerHTML = icons.highlighter;
    this.highlighterButton.addEventListener("click", () => change({ mode: "highlighter" }));

    SIZE_NAMES.forEach((name, index) => {
      const b = optionButton(`${name} line`);
      b.classList.add("size");
      const dot = document.createElement("span");
      dot.className = `dot dot-${index}`;
      b.append(dot);
      b.addEventListener("click", () => change({ size: index as SizeIndex, mode: "pen" }));
      this.sizeButtons.push(b);
    });

    this.eraserButton = optionButton("Eraser");
    this.eraserButton.classList.add("eraser");
    this.eraserButton.innerHTML = icons.eraser;
    this.eraserButton.addEventListener("click", () => change({ mode: "eraser" }));

    const done = document.createElement("button");
    done.type = "button";
    done.className = "done-button";
    done.title = "Stop drawing (Esc)";
    done.innerHTML = icons.check;
    done.append("Done");
    done.addEventListener("click", () => onDone());

    this.sizeGroup = group(...this.sizeButtons);
    this.element.append(
      group(...this.colorButtons, this.highlighterButton, this.eraserButton),
      this.sizeGroup,
      group(done),
    );
    this.refresh();
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  private refresh(): void {
    const { mode, penColor, size } = this.settings;
    PEN_COLORS.forEach((color, i) => {
      setPressed(this.colorButtons[i], mode === "pen" && penColor === color.value);
    });
    setPressed(this.highlighterButton, mode === "highlighter");
    setPressed(this.eraserButton, mode === "eraser");
    // Thickness only matters for the pen.
    this.sizeGroup.hidden = mode !== "pen";
    this.sizeButtons.forEach((b, i) => {
      setPressed(b, size === i);
      b.style.setProperty("--dot", penColor);
    });
  }
}

function optionButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "option";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", "false");
  return b;
}

function setPressed(b: HTMLButtonElement, pressed: boolean): void {
  b.setAttribute("aria-pressed", String(pressed));
}

function group(...children: HTMLElement[]): HTMLDivElement {
  const g = document.createElement("div");
  g.className = "option-group";
  g.append(...children);
  return g;
}
