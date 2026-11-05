/**
 * Zoom gestures: two-finger pinch on phones and tablets, Ctrl/Cmd + mouse
 * wheel and trackpad pinch on computers (Chrome reports a trackpad pinch as
 * a wheel event with the Ctrl key held), and Safari's own gesture events
 * (used later by the macOS app).
 *
 * While a pinch is in progress the pages are only stretched visually, which
 * is smooth. When the fingers lift, the real zoom is applied and the pages
 * are redrawn sharply.
 */
import { MAX_ZOOM, MIN_ZOOM, type ZoomAnchor } from "./zoom";

export interface ZoomGestureTarget {
  getZoom(): number;
  /** Apply the final zoom, keeping `anchor` still, then scroll by the pan distance. */
  commit(zoom: number, anchor: ZoomAnchor, panX: number, panY: number): void;
  enabled(): boolean;
}

interface Pinch {
  startZoom: number;
  startDistance: number;
  startX: number;
  startY: number;
  scale: number;
  panX: number;
  panY: number;
}

export function attachZoomGestures(
  scroller: HTMLElement,
  content: HTMLElement,
  target: ZoomGestureTarget,
): void {
  let pinch: Pinch | null = null;

  const clampScale = (startZoom: number, scale: number) =>
    Math.min(MAX_ZOOM / startZoom, Math.max(MIN_ZOOM / startZoom, scale));

  const preview = (p: Pinch) => {
    // Stretch the pages around the point between the fingers.
    const rect = scroller.getBoundingClientRect();
    const originX = scroller.scrollLeft + p.startX - rect.left - content.offsetLeft;
    const originY = scroller.scrollTop + p.startY - rect.top - content.offsetTop;
    content.style.transformOrigin = `${originX}px ${originY}px`;
    content.style.transform = `translate(${p.panX}px, ${p.panY}px) scale(${p.scale})`;
  };

  const finish = () => {
    if (!pinch) return;
    const p = pinch;
    pinch = null;
    content.style.transform = "";
    content.style.transformOrigin = "";
    target.commit(p.startZoom * p.scale, { clientX: p.startX, clientY: p.startY }, p.panX, p.panY);
  };

  // ----- Touch: two-finger pinch -----
  const distance = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const middle = (t: TouchList) => ({
    x: (t[0].clientX + t[1].clientX) / 2,
    y: (t[0].clientY + t[1].clientY) / 2,
  });

  scroller.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2 || !target.enabled()) return;
      const mid = middle(event.touches);
      pinch = {
        startZoom: target.getZoom(),
        startDistance: Math.max(1, distance(event.touches)),
        startX: mid.x,
        startY: mid.y,
        scale: 1,
        panX: 0,
        panY: 0,
      };
    },
    { passive: true },
  );

  scroller.addEventListener(
    "touchmove",
    (event) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const mid = middle(event.touches);
      pinch.scale = clampScale(pinch.startZoom, distance(event.touches) / pinch.startDistance);
      pinch.panX = mid.x - pinch.startX;
      pinch.panY = mid.y - pinch.startY;
      preview(pinch);
    },
    { passive: false },
  );

  const touchEnd = (event: TouchEvent) => {
    if (pinch && event.touches.length < 2) finish();
  };
  scroller.addEventListener("touchend", touchEnd);
  scroller.addEventListener("touchcancel", touchEnd);

  // ----- Ctrl/Cmd + wheel, and trackpad pinch in Chrome -----
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || !target.enabled()) return;
      event.preventDefault();
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 40 : event.deltaY;
      // A mouse wheel moves in big steps; a trackpad pinch in many small ones.
      const factor = Math.abs(pixels) >= 50 ? (pixels < 0 ? 1.1 : 1 / 1.1) : Math.exp(-pixels * 0.01);
      target.commit(target.getZoom() * factor, { clientX: event.clientX, clientY: event.clientY }, 0, 0);
    },
    { passive: false },
  );

  // ----- Safari (macOS app) trackpad pinch -----
  type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };
  scroller.addEventListener("gesturestart", (event) => {
    if (!target.enabled()) return;
    event.preventDefault();
    const e = event as GestureEvent;
    pinch = {
      startZoom: target.getZoom(),
      startDistance: 1,
      startX: e.clientX,
      startY: e.clientY,
      scale: 1,
      panX: 0,
      panY: 0,
    };
  });
  scroller.addEventListener("gesturechange", (event) => {
    if (!pinch) return;
    event.preventDefault();
    pinch.scale = clampScale(pinch.startZoom, (event as GestureEvent).scale);
    preview(pinch);
  });
  scroller.addEventListener("gestureend", (event) => {
    event.preventDefault();
    finish();
  });
}
