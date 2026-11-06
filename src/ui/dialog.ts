/** Simple pop-up messages and the password prompt, built on the browser's <dialog>. */

function createDialog(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  return dialog;
}

function heading(text: string): HTMLHeadingElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function button(label: string, primary: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = primary ? "button primary" : "button";
  b.textContent = label;
  return b;
}

export function showMessage(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    const dialog = createDialog();
    const ok = button("OK", true);
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    actions.append(ok);
    dialog.append(heading(title), paragraph(message), actions);
    ok.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => resolve());
    dialog.showModal();
  });
}

/** Asks a question with several answers (the last is the main one). Resolves to the chosen value, or null for Cancel. */
export function askChoice<T>(title: string, message: string, choices: { label: string; value: T }[], cancelLabel = "Cancel"): Promise<T | null> {
  return new Promise((resolve) => {
    const dialog = createDialog();
    const actions = document.createElement("div");
    actions.className = "dialog-actions wrap";
    const cancel = button(cancelLabel, false);
    cancel.addEventListener("click", () => dialog.close());
    actions.append(cancel);
    let result: T | null = null;
    choices.forEach((choice, i) => {
      const b = button(choice.label, i === choices.length - 1);
      b.addEventListener("click", () => {
        result = choice.value;
        dialog.close();
      });
      actions.append(b);
    });
    dialog.append(heading(title), paragraph(message), actions);
    dialog.addEventListener("close", () => resolve(result));
    dialog.showModal();
  });
}

/** Asks a yes/no question. Resolves to true if the confirm button was chosen. */
export function askConfirm(title: string, message: string, confirmLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = createDialog();
    const cancel = button(cancelLabel, false);
    const confirm = button(confirmLabel, true);
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    actions.append(cancel, confirm);
    dialog.append(heading(title), paragraph(message), actions);
    let result = false;
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => {
      result = true;
      dialog.close();
    });
    dialog.addEventListener("close", () => resolve(result));
    dialog.showModal();
    cancel.focus();
  });
}

/** Asks for a PDF's password. Resolves to null if cancelled. */
export function askPassword(wasWrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = createDialog();
    const form = document.createElement("form");
    form.method = "dialog";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "text-input";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Password");
    input.required = true;

    const cancel = button("Cancel", false);
    const open = button("Open", true);
    open.type = "submit";
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    actions.append(cancel, open);

    form.append(
      heading("Password needed"),
      paragraph(wasWrong ? "That password didn't work. Please try again." : "This PDF is protected. Enter its password to open it."),
      input,
      actions,
    );
    dialog.append(form);

    let result: string | null = null;
    form.addEventListener("submit", () => {
      result = input.value;
    });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => resolve(result));
    dialog.showModal();
    input.focus();
  });
}
