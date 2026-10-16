import { Check, ChevronDown } from "lucide-react";
import { Checkbox as CheckboxPrimitive, RadioGroup as RadioPrimitive, Select as SelectPrimitive } from "radix-ui";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const control = cn(
  "w-full rounded-[var(--radius-control)] border border-input bg-surface px-3 text-sm text-text-strong shadow-sm transition-colors",
  "placeholder:text-text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
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

export interface SelectOption { value: string; label: ReactNode }

/** Radix Select; an empty `value` shows the placeholder. */
export function Select({ id, value, onValueChange, options, placeholder = "请选择", disabled, className, "aria-label": ariaLabel }: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <SelectPrimitive.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger id={id} aria-label={ariaLabel}
        className={cn(control, "flex h-9 items-center justify-between gap-2 text-left data-[placeholder]:text-text-faint", className)}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon><ChevronDown className="size-4 text-text-muted" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow)] data-[state=open]:animate-in data-[state=open]:fade-in-0">
          <SelectPrimitive.Viewport className="p-1">
            {options.length === 0 && <div className="px-2 py-1.5 text-[13px] text-text-muted">没有可选项</div>}
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value}
                className="relative flex cursor-default select-none items-center rounded-md py-1.5 pl-2 pr-8 text-[13px] text-text outline-none data-[highlighted]:bg-surface-muted data-[highlighted]:text-text-strong">
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2"><Check className="size-3.5" /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Checkbox({ id, checked, onCheckedChange, label, description, disabled, className, "aria-label": ariaLabel }: {
  id?: string;
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const generated = useId();
  const boxId = id ?? generated;
  const box = (
    <CheckboxPrimitive.Root id={boxId} checked={checked} disabled={disabled} aria-label={ariaLabel}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      onClick={(event) => event.stopPropagation()}
      className="peer mt-px flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-surface shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-fg data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-fg">
      <CheckboxPrimitive.Indicator>
        {checked === "indeterminate" ? <span className="block h-0.5 w-2 rounded bg-current" /> : <Check className="size-3" strokeWidth={3} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label && !description) return box;
  return (
    <div className={cn("inline-flex items-start gap-2.5", className)}>
      {box}
      <label htmlFor={boxId} className="flex cursor-pointer flex-col text-sm">
        {label && <span className="text-text-strong">{label}</span>}
        {description && <span className="text-xs text-text-muted">{description}</span>}
      </label>
    </div>
  );
}

/** Exclusive choices shown as option cards (operation, first Run). */
export function RadioCards<T extends string>({ value, onValueChange, options, className }: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; title: ReactNode; description?: ReactNode; disabled?: boolean }[];
  className?: string;
}) {
  return (
    <RadioPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)} className={cn("grid gap-3", className)}>
      {options.map((option) => (
        <RadioPrimitive.Item key={option.value} value={option.value} disabled={option.disabled}
          className="group flex w-full items-start gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-text-strong data-[state=checked]:bg-surface-muted">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong group-data-[state=checked]:border-text-strong">
            <RadioPrimitive.Indicator className="size-2 rounded-full bg-text-strong" />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold text-text-strong">{option.title}</span>
            {option.description && <span className="text-xs leading-relaxed text-text-muted">{option.description}</span>}
          </span>
        </RadioPrimitive.Item>
      ))}
    </RadioPrimitive.Root>
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
