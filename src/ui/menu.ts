/** The "More" menu: less frequent actions, kept out of the toolbar to keep it clean. */
import { icons } from "./icons";

export class MoreMenu {
  readonly element: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly list: HTMLDivElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "more-menu";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "icon-button";
    this.button.title = "More";
    this.button.setAttribute("aria-label", "More");
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.innerHTML = icons.more;
    this.list = document.createElement("div");
    this.list.className = "menu-list";
    this.list.setAttribute("role", "menu");
    this.list.hidden = true;
    this.element.append(this.button, this.list);

    this.button.addEventListener("click", () => (this.list.hidden ? this.open() : this.close()));
    document.addEventListener("pointerdown", (e) => {
      if (!this.list.hidden && !this.element.contains(e.target as Node)) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.list.hidden) this.close();
    });
  }

  add(icon: string, label: string, shortcut: string, action: () => void): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item";
    item.setAttribute("role", "menuitem");
    item.innerHTML = icon;
    const text = document.createElement("span");
    text.textContent = label;
    item.append(text);
    if (shortcut) {
      const key = document.createElement("kbd");
      key.textContent = shortcut;
      item.append(key);
    }
    item.addEventListener("click", () => {
      this.close();
      action();
    });
    this.list.append(item);
    return item;
  }

  private open(): void {
    this.list.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.list.querySelector<HTMLElement>(".menu-item")?.focus();
  }

  private close(): void {
    this.list.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }
}
