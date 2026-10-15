import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const control = cn(
  "w-full rounded-[var(--radius-control)] border border-input bg-surface px-3 text-sm text-text-strong shadow-sm transition-colors",
  "placeholder:text-text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20",
  "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-text-muted aria-[invalid=true]:border-danger",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-9", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...props }, ref) {
    return <textarea ref={ref} className={cn(control, "min-h-24 py-2 leading-relaxed", mono && "font-mono text-[12.5px]", className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return <select ref={ref} className={cn(control, "h-9 cursor-pointer pr-8", className)} {...props}>{children}</select>;
});

export function Checkbox({ label, description, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-start gap-2.5 text-sm text-text", className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-input accent-[var(--primary)]" {...props} />
      {(label || description) && (
        <span className="flex flex-col">
          {label && <span className="text-text-strong">{label}</span>}
          {description && <span className="text-xs text-text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
}

/** A selectable option card for exclusive choices (operation, scope, first Run). */
export function RadioCard({ checked, onSelect, title, description, disabled }: {
  checked: boolean; onSelect: () => void; title: ReactNode; description?: ReactNode; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-[var(--radius-card)] border px-3.5 py-3 text-left transition-colors",
        checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-hover",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-accent" : "border-border-strong")}>
        {checked && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-text-strong">{title}</span>
        {description && <span className="text-xs leading-relaxed text-text-muted">{description}</span>}
      </span>
    </button>
  );
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
}

/** Label, help text and error for one control; the render prop receives the control id. */
export function Field({ label, hint, error, required, children, className }: FieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-text-strong">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}
