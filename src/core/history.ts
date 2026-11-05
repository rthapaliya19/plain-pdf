/**
 * Undo and redo. Every change is recorded as a command that knows how to
 * undo and redo itself, so each new feature gets undo for free.
 */
import type { EventHub } from "./events";

export interface Command {
  undo(): void;
  redo(): void;
}

const MAX_STEPS = 500;

export class History {
  private done: Command[] = [];
  private undone: Command[] = [];

  constructor(private readonly hub: EventHub) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Records a change that has already been made. */
  record(command: Command): void {
    this.done.push(command);
    if (this.done.length > MAX_STEPS) this.done.shift();
    this.undone = [];
    this.changed();
  }

  undo(): void {
    const command = this.done.pop();
    if (!command) return;
    command.undo();
    this.undone.push(command);
    this.changed();
  }

  redo(): void {
    const command = this.undone.pop();
    if (!command) return;
    command.redo();
    this.done.push(command);
    this.changed();
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.changed();
  }

  private changed(): void {
    this.hub.emit("history:changed", { canUndo: this.canUndo, canRedo: this.canRedo });
  }
}
