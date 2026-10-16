import { useId } from "react";
import { Field, FieldError, FieldLabel, Input } from "@springbrand/site-block";
import type { Metadata } from "@/api-sdk/bundles-api";

export function CatalogMetadataFields({ value, onChange, disabled, errors = {} }: {
  value: Metadata; onChange: (patch: Partial<Metadata>) => void; disabled?: boolean; errors?: Record<string, string>;
}) {
  const id = useId();
  return <div className="grid min-w-0 gap-4 md:grid-cols-2">
    <Field><FieldLabel htmlFor={`${id}-name`}>名称</FieldLabel>
      <Input id={`${id}-name`} required disabled={disabled} value={value.name} onChange={(event) => onChange({ name: event.target.value })} />
      <FieldError>{errors.name}</FieldError>
    </Field>
    <Field><FieldLabel htmlFor={`${id}-description`}>说明</FieldLabel>
      <Input id={`${id}-description`} required disabled={disabled} value={value.description} onChange={(event) => onChange({ description: event.target.value })} />
      <FieldError>{errors.description}</FieldError>
    </Field>
  </div>;
}
