/** Zoom limits shared by the viewer and the zoom gestures. 1 = 100%. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface ZoomAnchor {
  /** Point on screen (client coordinates) that should stay still while zooming. */
  clientX: number;
  clientY: number;
}
