"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Undo2 } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";

/**
 * "Liberar utilização" de uma reserva paga e depois cancelada. Justificativa
 * obrigatória e confirmação explícita. Reserva, pagamento e valores não mudam:
 * o uso só deixa de contar no limite do cupom.
 */
export function ReleaseRedemptionButton({ redemptionId, publicCode }: { redemptionId: string; publicCode: string }) {
  const router = useRouter();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);

  const release = async (reason: string) => {
    const response = await fetch(`/api/admin/coupons/redemptions/${redemptionId}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, confirmed: true }),
    });
    const payload = (await response.json().catch(() => ({}))) as { message?: string; replayed?: boolean };
    if (response.status === 409 && payload.replayed === true) {
      setOpen(false);
      notify({ title: "Nada foi alterado", description: payload.message });
      router.refresh();
      return;
    }
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível liberar a utilização.");
    setOpen(false);
    notify({ title: "Utilização liberada", description: payload.message });
    router.refresh();
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="size-4" /> Liberar
      </Button>
      <ConfirmationDialog
        open={open}
        title="Liberar esta utilização?"
        description={`A utilização da reserva ${publicCode} deixa de contar no limite do cupom. A reserva, o pagamento e os valores registrados não mudam. A justificativa fica na auditoria.`}
        confirmLabel="Liberar utilização"
        requireReason
        onClose={() => setOpen(false)}
        onConfirm={release}
      />
    </>
  );
}
