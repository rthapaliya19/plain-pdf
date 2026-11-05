/**
 * The two signature pop-ups:
 *  - the signature pad, where you draw your signature once
 *  - "Your signature", shown when one is already saved: place it, draw a
 *    new one, or remove it from this device
 */
import type { SignatureInk } from "../../core/additions";
import { smoothPath } from "../../overlay/paths";
import { SIGNATURE_COLOR } from "./signature-store";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Pen thickness on the pad, in screen pixels. */
const PAD_LINE_WIDTH = 2.6;

/** Draws a saved signature as a picture (for previews). */
export function inkPicture(ink: SignatureInk): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${ink.width} ${ink.height}`);
  svg.setAttribute("aria-hidden", "true");
  for (const points of ink.strokes) svg.append(inkPath(points, ink.lineWidth, ink.color));
  return svg;
}

function inkPath(points: number[], width: number, color: string): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", smoothPath(points));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", String(width));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  return path;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, className: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  return b;
}

function modal(className: string): HTMLDialogElement {
  const dialog = el("dialog", `dialog ${className}`);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  // Clicking the dimmed area outside closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) dialog.close();
  });
  const close = button("×", "dialog-close");
  close.setAttribute("aria-label", "Close");
  close.title = "Close";
  close.addEventListener("click", () => dialog.close());
  dialog.append(close);
  return dialog;
}

/** Shows the signature pad. Resolves to the drawn signature, or null if cancelled. */
export function drawSignature(): Promise<SignatureInk | null> {
  return new Promise((resolve) => {
    const dialog = modal("signature-dialog");
    const pad = el("div", "signature-pad");
    const line = el("div", "signature-line");
    const hint = el("span", "signature-hint", "Sign above the line");
    const svg = document.createElementNS(SVG_NS, "svg");
    pad.append(line, hint, svg);

    const clear = button("Clear", "button");
    const cancel = button("Cancel", "button");
    const save = button("Save signature", "button primary");
    save.disabled = true;
    clear.disabled = true;
    const actions = el("div", "dialog-actions");
    actions.append(clear, el("span", "spacer"), cancel, save);

    dialog.append(
      el("h2", "", "Draw your signature"),
      el("p", "", "Use your finger, mouse or trackpad. It's saved only on this device."),
      pad,
      actions,
    );

    const strokes: number[][] = [];
    let current: { id: number; points: number[]; path: SVGPathElement } | null = null;

    const refresh = () => {
      const empty = strokes.length === 0 && !current;
      save.disabled = empty;
      clear.disabled = empty;
      hint.hidden = !empty;
    };

    const local = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    pad.addEventListener("pointerdown", (e) => {
      if (current || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      const path = inkPath([], PAD_LINE_WIDTH, SIGNATURE_COLOR);
      svg.append(path);
      current = { id: e.pointerId, points: local(e), path };
      path.setAttribute("d", smoothPath(current.points));
      refresh();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!current || e.pointerId !== current.id) return;
      const samples = typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e];
      for (const s of samples) {
        const [x, y] = local(s);
        const pts = current.points;
        if (Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]) >= 0.75) pts.push(x, y);
      }
      current.path.setAttribute("d", smoothPath(current.points));
    });
    const end = (e: PointerEvent) => {
      if (!current || e.pointerId !== current.id) return;
      strokes.push(current.points);
      current = null;
      refresh();
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);

    clear.addEventListener("click", () => {
      strokes.length = 0;
      svg.replaceChildren();
      refresh();
    });

    let result: SignatureInk | null = null;
    cancel.addEventListener("click", () => dialog.close());
    save.addEventListener("click", () => {
      // Include a line that's still being drawn (e.g. a finger still on the pad).
      const all = current ? [...strokes, current.points] : strokes;
      if (all.every((pts) => pts.length < 2)) return;
      result = normalise(all);
      dialog.close();
    });
    dialog.addEventListener("close", () => resolve(result));
    dialog.showModal();
    save.blur();
  });
}

/** Crops the drawing to its edges so it can be placed and sized on any page. */
function normalise(strokes: number[][]): SignatureInk {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pts of strokes) {
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
  }
  const margin = PAD_LINE_WIDTH;
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    width: round(Math.max(maxX - minX, 1) + 2 * margin),
    height: round(Math.max(maxY - minY, 1) + 2 * margin),
    strokes: strokes.map((pts) => pts.map((v, i) => round(v - (i % 2 === 0 ? minX : minY) + margin))),
    lineWidth: PAD_LINE_WIDTH,
    color: SIGNATURE_COLOR,
  };
}

export type SignMenuChoice = "place" | "redraw" | "remove" | null;

/** "Your signature": place the saved one, draw a new one, or remove it. */
export function chooseSignatureAction(ink: SignatureInk): Promise<SignMenuChoice> {
  return new Promise((resolve) => {
    const dialog = modal("signature-dialog");
    const preview = button("", "signature-preview");
    preview.setAttribute("aria-label", "Place your signature on the page");
    preview.title = "Place on the page";
    preview.append(inkPicture(ink));

    const remove = button("Remove", "button danger-text");
    remove.title = "Remove your saved signature from this device";
    const redraw = button("Draw new", "button");
    const place = button("Place on page", "button primary");
    const actions = el("div", "dialog-actions");
    actions.append(remove, el("span", "spacer"), redraw, place);

    dialog.append(el("h2", "", "Your signature"), el("p", "", "Saved only on this device."), preview, actions);

    let choice: SignMenuChoice = null;
    const pick = (c: SignMenuChoice) => () => {
      choice = c;
      dialog.close();
    };
    preview.addEventListener("click", pick("place"));
    place.addEventListener("click", pick("place"));
    redraw.addEventListener("click", pick("redraw"));
    remove.addEventListener("click", pick("remove"));
    dialog.addEventListener("close", () => resolve(choice));
    dialog.showModal();
    place.focus();
  });
}
