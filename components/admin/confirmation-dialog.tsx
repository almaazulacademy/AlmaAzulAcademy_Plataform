"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { fieldErrorClass, labelClass, textareaClass } from "@/components/admin/form-styles";
import { Button } from "@/components/ui/button";

type ConfirmationDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  requireReason?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
};

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  requireReason = false,
  onClose,
  onConfirm,
}: ConfirmationDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setReason("");
      setError("");
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [loading, onClose, open]);

  if (!open) return null;

  const submit = async () => {
    if (requireReason && reason.trim().length < 3) {
      setError("Informe um motivo com pelo menos 3 caracteres.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onConfirm(reason.trim());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível concluir a ação.");
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/55 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !loading) onClose();
    }}>
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-soft sm:p-8" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description">
        <div className="flex items-start justify-between gap-4">
          <div className="grid size-11 place-items-center rounded-2xl bg-red-50 text-red-700">
            <AlertTriangle className="size-5" />
          </div>
          <button type="button" onClick={onClose} disabled={loading} className="grid size-9 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar confirmação">
            <X className="size-5" />
          </button>
        </div>
        <h2 id="confirmation-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">{title}</h2>
        <p id="confirmation-description" className="mt-3 text-sm leading-6 text-ink/60">{description}</p>
        {requireReason ? (
          <label className="mt-6 block">
            <span className={labelClass}>Motivo da ação</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} className={textareaClass} maxLength={500} disabled={loading} autoFocus />
          </label>
        ) : null}
        {error ? <p className={fieldErrorClass} role="alert">{error}</p> : null}
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>Voltar</Button>
          <Button type="button" onClick={submit} disabled={loading} className="bg-red-700 hover:bg-red-800">
            {loading ? "Processando..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
