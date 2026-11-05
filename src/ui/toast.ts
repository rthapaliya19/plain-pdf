/** A short message that appears near the bottom of the screen and fades away. */
let current: HTMLDivElement | null = null;
let timer = 0;

export function showToast(message: string, durationMs = 3500): void {
  current?.remove();
  clearTimeout(timer);
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.append(toast);
  current = toast;
  timer = window.setTimeout(() => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 300);
    if (current === toast) current = null;
  }, durationMs);
}
