import React, { useEffect, useId, useRef } from "react";

export type UiButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface UiButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: UiButtonVariant;
  fullWidth?: boolean;
  loading?: boolean;
}

export function UiButton({
  variant = "secondary",
  fullWidth = false,
  loading = false,
  className = "",
  disabled,
  children,
  ...props
}: UiButtonProps) {
  const classes = [
    "bg-button",
    `bg-button--${variant}`,
    fullWidth ? "bg-button--full" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <button
      {...props}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="bg-spinner" aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

export interface UiIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

export function UiIcon({ label, className = "", children, ...props }: UiIconProps) {
  return (
    <span
      {...props}
      className={["bg-icon", className].filter(Boolean).join(" ")}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {children}
    </span>
  );
}

export interface UiIconButtonProps extends UiButtonProps {
  label: string;
}

export function UiIconButton({ label, className = "", children, ...props }: UiIconButtonProps) {
  return (
    <UiButton {...props} className={["bg-icon-button", className].filter(Boolean).join(" ")} aria-label={label}>
      {children}
    </UiButton>
  );
}

export interface UiFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
  id?: string;
  label: string;
  description?: React.ReactNode;
  error?: React.ReactNode;
  containerClassName?: string;
}

export const UiField = React.forwardRef<HTMLInputElement, UiFieldProps>(function UiField({
  id,
  label,
  description,
  error,
  className = "",
  containerClassName = "",
  "aria-describedby": ariaDescribedBy,
  ...props
}, ref) {
  const generatedId = useId();
  const inputId = id || `bg-field-${generatedId.replace(/:/g, "")}`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={["bg-field-wrap", containerClassName].filter(Boolean).join(" ")}>
      <label className="bg-label" htmlFor={inputId}>{label}</label>
      <input
        {...props}
        ref={ref}
        id={inputId}
        className={["bg-field", className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={describedBy}
      />
      {description && <div id={descriptionId} className="bg-field-description">{description}</div>}
      {error && <div id={errorId} className="bg-field-error">{error}</div>}
    </div>
  );
});

export interface UiFeedbackProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "error" | "success" | "info";
}

export function UiFeedback({ tone = "info", className = "", children, ...props }: UiFeedbackProps) {
  return (
    <div {...props} className={["bg-feedback", `bg-feedback--${tone}`, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function UiSpinner({ label = "Loading" }: { label?: string }) {
  return <span className="bg-spinner" role="status" aria-label={label} />;
}

function focusableElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

export interface UiDialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  dismissible?: boolean;
}

export function UiDialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
  dismissible = true,
}: UiDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusables = panel ? focusableElements(panel) : [];
    (focusables[0] || panel)?.focus();

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = focusableElements(panel);
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [dismissible, onClose, open]);

  if (!open) return null;
  return (
    <div
      className="bg-dialog-backdrop"
      onMouseDown={event => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="bg-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <h2 id={titleId} className="bg-dialog__title">{title}</h2>
        {description && <p id={descriptionId} className="bg-dialog__description">{description}</p>}
        <div className="bg-dialog__body">{children}</div>
        {actions && <div className="bg-dialog__actions">{actions}</div>}
      </div>
    </div>
  );
}
