import { useId, useState, type ReactNode } from "react";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Field, FieldLabel, Input } from "@springbrand/site-block";

interface MetadataDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  initial?: { name: string; description: string };
  onSubmit: (value: { name: string; description: string }) => void;
  loading?: boolean;
  children?: ReactNode;
  submitLabel?: string;
  extraValid?: boolean;
}

/** Each opening creates one metadata draft; catalog refreshes never replace it. */
export function MetadataDialog(props: MetadataDialogProps) {
  return props.open ? <MetadataForm {...props} /> : null;
}

function MetadataForm({ onClose, title, initial, onSubmit, loading, children, submitLabel = "保存", extraValid = true }: MetadataDialogProps) {
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const valid = !!name.trim() && !!description.trim() && extraValid;
  return <Dialog open onOpenChange={(next) => { if (!next && !loading) onClose(); }}>
    <DialogContent className={`flex max-h-[calc(100dvh-2rem)] flex-col ${children ? "sm:max-w-2xl" : "sm:max-w-lg"}`} showCloseButton={!loading}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (valid && !loading) onSubmit({ name: name.trim(), description: description.trim() }); }}>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
          <div className="grid gap-4 md:grid-cols-2">
            <Field><FieldLabel htmlFor={nameId}>名称</FieldLabel><Input id={nameId} required disabled={loading} value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor={descriptionId}>描述</FieldLabel><Input id={descriptionId} required disabled={loading} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
          </div>
          {children}
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={loading} onClick={onClose}>取消</Button>
          <Button type="submit" loading={loading} disabled={!valid}>{submitLabel}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
