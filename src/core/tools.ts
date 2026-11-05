/**
 * Tools (Draw now, Sign later) plug in here. Only one tool is active at a
 * time; turning one on turns the others off.
 */
import type { EventHub } from "./events";

export interface Tool {
  readonly id: string;
  activate(): void;
  deactivate(): void;
}

export class ToolManager {
  private tools = new Map<string, Tool>();
  private active: Tool | null = null;

  constructor(private readonly hub: EventHub) {}

  get activeId(): string | null {
    return this.active?.id ?? null;
  }

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  activate(id: string): void {
    const tool = this.tools.get(id);
    if (!tool || tool === this.active) return;
    this.active?.deactivate();
    this.active = tool;
    tool.activate();
    this.hub.emit("tool:changed", { id });
  }

  deactivate(): void {
    if (!this.active) return;
    this.active.deactivate();
    this.active = null;
    this.hub.emit("tool:changed", { id: null });
  }

  toggle(id: string): void {
    if (this.active?.id === id) this.deactivate();
    else this.activate(id);
  }
}
