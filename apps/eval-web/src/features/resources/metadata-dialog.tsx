import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";

/** Name and description, both required, for Bundles, Materials and Sessions. */
export function MetadataDialog({ open, onClose, title, initial, onSubmit, loading, children, submitLabel = "保存", extraValid = true }: {
  open: boolean;
  onClose: () => void;
  title: string;
  initial?: { name: string; description: string };
  onSubmit: (value: { name: string; description: string }) => void;
  loading?: boolean;
  children?: ReactNode;
  submitLabel?: string;
  extraValid?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setDescription(initial?.description ?? "");
    }
  }, [open, initial?.name, initial?.description]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size={children ? "lg" : "sm"}
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={loading} disabled={!name.trim() || !description.trim() || !extraValid}
            onClick={() => onSubmit({ name: name.trim(), description: description.trim() })}>{submitLabel}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="名称" required>{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
          <Field label="说明" required>{(id) => <Input id={id} value={description} onChange={(event) => setDescription(event.target.value)} />}</Field>
        </div>
        {children}
      </div>
    </Dialog>
  );
}
