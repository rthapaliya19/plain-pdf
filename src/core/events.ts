/**
 * A tiny typed event hub. Parts of the app (toolbar, viewer, tools) talk to
 * each other through these events instead of reaching into each other
 * directly, so new features can be added without rewiring existing ones.
 */
export type AppEvents = {
  "document:opened": { name: string; pageCount: number };
  "document:closed": Record<string, never>;
  "page:changed": { page: number; pageCount: number };
  "zoom:changed": { zoom: number; fitWidth: boolean };
  /** Drawings or other additions changed on these pages (0-based). */
  "additions:changed": { pages: number[] };
  "history:changed": { canUndo: boolean; canRedo: boolean };
  /** Pages were rotated, deleted, moved or added (or that was undone). */
  "pages:changed": { pageCount: number };
  /** The active tool changed. null = just viewing. */
  "tool:changed": { id: string | null };
};

type Handler<T> = (payload: T) => void;

export class EventHub<Events extends Record<string, unknown> = AppEvents> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as Handler<Events[K]>)(payload);
    }
  }
}
