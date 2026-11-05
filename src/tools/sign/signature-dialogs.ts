/**
 * The signature pop-ups:
 *  - the drawing pad, where you draw your signature or initials once
 *  - the Sign panel, with two slots (Signature and Initials): tap one to
 *    place it, draw a new one, or remove it from this device
 */
import type { SignatureInk } from "../../core/additions";
import { smoothPath } from "../../overlay/paths";
import { SIGNATURE_COLOR, type InkKind } from "./signature-store";

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

const WORDS: Record<InkKind, { title: string; hint: string; save: string; label: string }> = {
  signature: { title: "Draw your signature", hint: "Sign above the line", save: "Save signature", label: "Signature" },
  initials: { title: "Draw your initials", hint: "Write your initials above the line", save: "Save initials", label: "Initials" },
};

/** Shows the drawing pad. Resolves to the drawing, or null if cancelled. */
export function drawInk(kind: InkKind): Promise<SignatureInk | null> {
  const words = WORDS[kind];
  return new Promise((resolve) => {
    const dialog = modal("signature-dialog");
    const pad = el("div", "signature-pad");
    const line = el("div", "signature-line");
    const hint = el("span", "signature-hint", words.hint);
    const svg = document.createElementNS(SVG_NS, "svg");
    pad.append(line, hint, svg);

    const clear = button("Clear", "button");
    const cancel = button("Cancel", "button");
    const save = button(words.save, "button primary");
    save.disabled = true;
    clear.disabled = true;
    const actions = el("div", "dialog-actions");
    actions.append(clear, el("span", "spacer"), cancel, save);

    dialog.append(
      el("h2", "", words.title),
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

export type SignPanelChoice = { kind: InkKind; action: "place" | "draw" | "remove" } | null;

/**
 * The Sign panel: a slot for your signature and one for your initials.
 * Tap a saved one to place it; an empty slot opens the pad.
 */
export function chooseFromSignPanel(saved: Record<InkKind, SignatureInk | null>): Promise<SignPanelChoice> {
  return new Promise((resolve) => {
    const dialog = modal("signature-dialog sign-panel");
    let choice: SignPanelChoice = null;
    const pick = (kind: InkKind, action: "place" | "draw" | "remove") => () => {
      choice = { kind, action };
      dialog.close();
    };

    const slots = el("div", "sign-slots");
    for (const kind of ["signature", "initials"] as const) {
      const ink = saved[kind];
      const slot = el("section", `sign-slot sign-slot-${kind}`);
      slot.append(el("h3", "", WORDS[kind].label));
      if (ink) {
        const preview = button("", "signature-preview");
        preview.setAttribute("aria-label", `Place your ${kind} on the page`);
        preview.title = "Tap to place it on the page";
        preview.append(inkPicture(ink));
        preview.addEventListener("click", pick(kind, "place"));
        const redraw = button("Draw new", "link-button");
        redraw.addEventListener("click", pick(kind, "draw"));
        const remove = button("Remove", "link-button danger-text");
        remove.title = `Remove your saved ${kind} from this device`;
        remove.addEventListener("click", pick(kind, "remove"));
        const links = el("div", "slot-links");
        links.append(redraw, remove);
        slot.append(preview, links);
      } else {
        const add = button(`+ Add ${kind === "signature" ? "signature" : "initials"}`, "signature-preview empty");
        add.addEventListener("click", pick(kind, "draw"));
        slot.append(add);
      }
      slots.append(slot);
    }

    dialog.append(
      el("h2", "", "Sign"),
      el("p", "", "Tap one to place it on the page. Saved only on this device."),
      slots,
    );
    dialog.addEventListener("close", () => resolve(choice));
    dialog.showModal();
    (dialog.querySelector(".signature-preview") as HTMLElement | null)?.focus();
  });
}
