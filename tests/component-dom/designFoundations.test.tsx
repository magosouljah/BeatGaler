import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UiButton, UiDialog, UiField, UiFeedback, UiIconButton } from "../../src/components/ui/DesignPrimitives";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

function luminance(hex: string) {
  const rgb = hex.match(/[0-9a-f]{2}/gi)?.map(value => parseInt(value, 16) / 255) || [];
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("Design Foundations 11.1", () => {
  it("exposes shared button, field, icon and feedback states with accessible semantics", () => {
    const { host, root } = mount(<>
      <UiButton variant="primary" loading>Saving</UiButton>
      <UiIconButton label="Close dialog"><span aria-hidden="true">×</span></UiIconButton>
      <UiField label="Email" description="Used for account notices" error="Invalid email" />
      <UiFeedback tone="error" role="alert">Could not save</UiFeedback>
    </>);

    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].getAttribute("aria-busy")).toBe("true");
    expect(buttons[0].classList.contains("bg-button--primary")).toBe(true);
    expect(buttons[0].textContent).toContain("Saving");
    expect(buttons[1].getAttribute("aria-label")).toBe("Close dialog");
    expect(buttons[1].classList.contains("bg-icon-button")).toBe(true);

    const input = host.querySelector<HTMLInputElement>("input");
    const label = host.querySelector("label");
    expect(label?.htmlFor).toBe(input?.id);
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input?.getAttribute("aria-describedby") || "";
    expect(describedBy).toContain(`${input?.id}-description`);
    expect(describedBy).toContain(`${input?.id}-error`);
    expect(host.querySelector('[role="alert"]')?.classList.contains("bg-feedback--error")).toBe(true);

    act(() => root.unmount());
    host.remove();
  });

  it("Dialog is modal, traps keyboard focus, closes with Escape and restores focus", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open settings";
    document.body.appendChild(trigger);
    trigger.focus();

    const onClose = vi.fn();
    const { host, root } = mount(
      <UiDialog
        open
        title="Confirm change"
        description="Review before continuing"
        onClose={onClose}
        actions={<button type="button">Confirm</button>}
      >
        <button type="button">Cancel</button>
      </UiDialog>,
    );

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.activeElement).toBe(buttons[0]);

    act(() => {
      buttons[buttons.length - 1].focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[0]);

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();

    act(() => root.render(
      <UiDialog open={false} title="Confirm change" onClose={onClose}>Closed</UiDialog>,
    ));
    expect(document.activeElement).toBe(trigger);

    act(() => root.unmount());
    host.remove();
    trigger.remove();
  });

  it("keeps AccountGate text tokens above WCAG AA contrast on its dark surfaces", () => {
    expect(contrast("#f2f2f2", "#101010")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#b0b0b0", "#101010")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#8b8b8b", "#101010")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffb4b4", "#2a1111")).toBeGreaterThanOrEqual(4.5);
  });

  it("defines high-contrast focus, dark autofill, 390-430 layouts and reduced motion", () => {
    const css = readFileSync(path.resolve(process.cwd(), "src/styles/design-foundations.css"), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 2px solid var(--focus-ring)");
    expect(css).toContain(".bg-field:-webkit-autofill");
    expect(css).toContain("-webkit-text-fill-color: var(--text-primary)");
    expect(css).toContain("@media (max-width: 430px)");
    expect(css).toContain("@media (max-width: 390px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration: 0.01ms !important");
  });
});
