"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Power, PowerOff } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";

/**
 * Ativar ou desativar um cupom (só aparece para ADMIN; a rota e o banco
 * recusam o OPERATOR de qualquer forma). Desativar só impede novos usos.
 */
export function CouponStatusButton({ couponId, code, status }: { couponId: string; code: string; status: "ACTIVE" | "INACTIVE" }) {
  const router = useRouter();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const activating = status === "INACTIVE";

  const submit = async (reason: string) => {
    const response = await fetch(`/api/admin/coupons/${couponId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: activating ? "ACTIVE" : "INACTIVE", reason }),
    });
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível alterar o cupom.");
    setOpen(false);
    notify({ title: activating ? "Cupom ativado" : "Cupom desativado", description: payload.message });
    router.refresh();
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {activating ? <Power className="size-4" /> : <PowerOff className="size-4" />} {activating ? "Ativar" : "Desativar"}
      </Button>
      <ConfirmationDialog
        open={open}
        title={activating ? `Ativar o cupom ${code}?` : `Desativar o cupom ${code}?`}
        description={activating
          ? "O cupom volta a aceitar novas utilizações, dentro da validade, do limite e das experiências elegíveis. O motivo é opcional e fica na auditoria."
          : "Novas utilizações passam a ser recusadas. As reservas já feitas com o cupom mantêm o valor com desconto, e o histórico de utilizações e a auditoria são preservados. O motivo é opcional."}
        confirmLabel={activating ? "Ativar cupom" : "Desativar cupom"}
        tone={activating ? "neutral" : "danger"}
        optionalReason
        onClose={() => setOpen(false)}
        onConfirm={submit}
      />
    </>
  );
}
