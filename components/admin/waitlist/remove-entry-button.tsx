"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserMinus } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";

/**
 * "Remover da lista de espera". Motivo obrigatório e confirmação: a pessoa deixa
 * de ser avisada sobre esta turma. Não toca reserva nem pagamento. O nome
 * aparece só no diálogo, para a equipe conferir quem está removendo.
 */
export function RemoveWaitlistEntryButton({ entryId, fullName }: { entryId: string; fullName: string | null }) {
  const router = useRouter();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);

  const remove = async (reason: string) => {
    const response = await fetch(`/api/admin/waitlist/${entryId}/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, confirmed: true }),
    });
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    if (response.status === 409) {
      setOpen(false);
      notify({ title: "Nada foi alterado", description: payload.message ?? "Esta inscrição já não estava ativa." });
      router.refresh();
      return;
    }
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível remover a inscrição.");
    setOpen(false);
    notify({ title: "Inscrição removida", description: payload.message ?? "A pessoa não será mais avisada sobre esta turma." });
    router.refresh();
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UserMinus className="size-4" /> Remover
      </Button>
      <ConfirmationDialog
        open={open}
        title="Remover da lista de espera?"
        description={`${fullName ?? "Esta pessoa"} deixa de ser avisada sobre esta turma. A remoção fica registrada na auditoria com o motivo. Nenhuma reserva ou pagamento é afetado.`}
        confirmLabel="Remover inscrição"
        requireReason
        onClose={() => setOpen(false)}
        onConfirm={remove}
      />
    </>
  );
}
