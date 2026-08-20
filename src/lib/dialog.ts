import { sanitizeUserVisibleText } from "./userVisibleError";

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type AlertOptions = {
  title?: string;
  message: string;
  buttonLabel?: string;
  danger?: boolean;
};

let activeDialogCleanup: (() => void) | null = null;

function makeButton(label: string, kind: "default" | "primary" | "danger"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  Object.assign(button.style, {
    minWidth: "86px",
    height: "34px",
    padding: "0 14px",
    borderRadius: "8px",
    fontFamily: "'DM Sans', sans-serif",
    fontSize: "12px",
    fontWeight: kind === "default" ? "500" : "600",
    cursor: "pointer",
    outline: "none",
    transition: "background 120ms ease, border-color 120ms ease, transform 80ms ease",
  });

  if (kind === "danger") {
    Object.assign(button.style, {
      background: "#2a1515",
      border: "1px solid #4a2323",
      color: "#fca5a5",
    });
  } else if (kind === "primary") {
    Object.assign(button.style, {
      background: "#e7e7e7",
      border: "1px solid #f0f0f0",
      color: "#111",
    });
  } else {
    Object.assign(button.style, {
      background: "#171717",
      border: "1px solid #2b2b2b",
      color: "#aaa",
    });
  }

  button.onmousedown = () => { button.style.transform = "scale(0.98)"; };
  button.onmouseup = () => { button.style.transform = "scale(1)"; };
  button.onmouseleave = () => { button.style.transform = "scale(1)"; };
  return button;
}

function createShell(title: string, message: string, danger: boolean) {
  // Only one application dialog can be active at once.
  activeDialogCleanup?.();

  const overlay = document.createElement("div");
  overlay.setAttribute("data-beatgaler-dialog", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "20000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    background: "rgba(0,0,0,0.66)",
    backdropFilter: "blur(5px)",
    fontFamily: "'DM Sans', sans-serif",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    width: "min(430px, calc(100vw - 40px))",
    background: "#111",
    border: `1px solid ${danger ? "#3a2222" : "#272727"}`,
    borderRadius: "13px",
    boxShadow: "0 24px 80px rgba(0,0,0,0.72)",
    overflow: "hidden",
  });

  const body = document.createElement("div");
  Object.assign(body.style, { padding: "20px 20px 17px" });

  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  Object.assign(titleEl.style, {
    color: danger ? "#f3d0d0" : "#e8e8e8",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "1.35",
  });

  const messageEl = document.createElement("div");
  messageEl.textContent = message;
  Object.assign(messageEl.style, {
    marginTop: "9px",
    whiteSpace: "pre-wrap",
    color: "#858585",
    fontSize: "12px",
    lineHeight: "1.55",
  });

  const footer = document.createElement("div");
  Object.assign(footer.style, {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "12px 16px",
    borderTop: "1px solid #202020",
    background: "#0d0d0d",
  });

  body.append(titleEl, messageEl);
  panel.append(body, footer);
  overlay.append(panel);
  document.body.append(overlay);

  return { overlay, panel, footer };
}

export function appConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const { overlay, panel, footer } = createShell(options.title, options.message, !!options.danger);
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      if (activeDialogCleanup === cleanup) activeDialogCleanup = null;
      resolve(value);
    };

    const cleanup = () => finish(false);
    activeDialogCleanup = cleanup;

    const cancel = makeButton(options.cancelLabel ?? "Cancel", "default");
    const confirm = makeButton(
      options.confirmLabel ?? "Confirm",
      options.danger ? "danger" : "primary"
    );

    cancel.onclick = () => finish(false);
    confirm.onclick = () => finish(true);

    overlay.onclick = e => {
      if (e.target === overlay) finish(false);
    };
    panel.onclick = e => e.stopPropagation();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    footer.append(cancel, confirm);
    requestAnimationFrame(() => cancel.focus());
  });
}

export function appAlert(options: AlertOptions | string): Promise<void> {
  const normalized: AlertOptions =
    typeof options === "string" ? { message: options } : options;

  return new Promise(resolve => {
    const { overlay, panel, footer } = createShell(
      normalized.title ?? (normalized.danger ? "Something went wrong" : "Beat Galer"),
      sanitizeUserVisibleText(normalized.message, "Something went wrong."),
      !!normalized.danger
    );
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      if (activeDialogCleanup === cleanup) activeDialogCleanup = null;
      resolve();
    };

    const cleanup = () => finish();
    activeDialogCleanup = cleanup;

    const ok = makeButton(normalized.buttonLabel ?? "OK", "primary");
    ok.onclick = finish;

    overlay.onclick = e => {
      if (e.target === overlay) finish();
    };
    panel.onclick = e => e.stopPropagation();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    footer.append(ok);
    requestAnimationFrame(() => ok.focus());
  });
}
