"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, Copy, ExternalLink, Mail, MessageCircle, RotateCcw, SearchCheck, Sheet, XCircle } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { reservationMessage } from "@/lib/admin/format";
import type { ReservationStatus } from "@/lib/reservations/types";

type Action = "confirm" | "cancel" | null;
type ApiPayload = { message?: string };
type VerifyPayload = { success?: boolean; outcome?: string; message?: string };
type SyncPayload = { success?: boolean; outcome?: string; errorCode?: string; message?: string };

export function ReservationActions({ reservationId, status, fullName, phone, email, publicCode, checkoutUrl, showMessageButton = false, showSheetSync = false }: {
  reservationId: string;
  status: ReservationStatus;
  fullName: string;
  phone: string;
  email: string;
  publicCode: string;
  checkoutUrl?: string | null;
  showMessageButton?: boolean;
  showSheetSync?: boolean;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [action, setAction] = useState<Action>(null);
  const [verifying, setVerifying] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const verifyPayment = async () => {
    setVerifying(true);
    try {
      const response = await fetch(`/api/admin/reservations/${reservationId}/verify-payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({})) as VerifyPayload;
      const description = payload.message ?? "Não foi possível verificar o pagamento agora.";
      notify({
        title: payload.success ? "Pagamento confirmado" : "Pagamento não confirmado",
        description,
        variant: payload.success ? undefined : "error",
      });
      if (payload.success) router.refresh();
    } catch {
      notify({ title: "Falha na verificação", description: "Não foi possível falar com a InfinitePay.", variant: "error" });
    } finally {
      setVerifying(false);
    }
  };

  // Reenvia a reserva para a planilha operacional. Idempotente: repetir não
  // duplica ninguém na lista da turma.
  const syncSheet = async () => {
    setSyncing(true);
    try {
      const response = await fetch(`/api/admin/reservations/${reservationId}/sync-sheet`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as SyncPayload;
      notify({
        title: payload.success ? "Planilha sincronizada" : "Sincronização pendente",
        description: payload.message ?? "Não foi possível falar com o Google Sheets agora.",
        variant: payload.success ? undefined : "error",
      });
      router.refresh();
    } catch {
      notify({ title: "Falha na sincronização", description: "Não foi possível falar com o Google Sheets.", variant: "error" });
    } finally {
      setSyncing(false);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: `${label} copiado` });
    } catch {
      notify({ title: "Não foi possível copiar", description: "Selecione o conteúdo manualmente.", variant: "error" });
    }
  };

  const executeAction = async (reason: string) => {
    if (!action) return;
    const response = await fetch(`/api/admin/reservations/${reservationId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: action === "confirm" ? "CONFIRM_PAYMENT" : "CANCEL", reason }),
    });
    const payload = await response.json().catch(() => ({})) as ApiPayload;
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível concluir a ação.");
    notify({
      title: action === "confirm" ? "Pagamento confirmado manualmente" : "Reserva cancelada",
      description: "A ação foi registrada na trilha de auditoria.",
    });
    setAction(null);
    router.refresh();
  };

  const openWhatsappDraft = () => {
    const normalizedPhone = phone.replace(/\D/g, "");
    const message = reservationMessage(fullName, publicCode);
    window.open(`https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
    notify({ title: "Mensagem preparada", description: "Revise o texto no WhatsApp antes de enviar." });
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {status !== "CONFIRMED" && status !== "CANCELLED" ? (
          <Button type="button" size="sm" variant="ghost" disabled={verifying} onClick={verifyPayment}>
            <SearchCheck className="size-4" /> {verifying ? "Verificando…" : "Verificar pagamento"}
          </Button>
        ) : null}
        {status !== "CONFIRMED" && status !== "CANCELLED" ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setAction("confirm")}><CheckCircle2 className="size-4" /> Confirmar pagamento</Button>
        ) : null}
        {status !== "CANCELLED" ? (
          <Button type="button" size="sm" variant="ghost" className="text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setAction("cancel")}><XCircle className="size-4" /> Cancelar</Button>
        ) : null}
        {showSheetSync ? (
          <Button type="button" size="sm" variant="ghost" disabled={syncing} onClick={syncSheet}>
            <Sheet className="size-4" /> {syncing ? "Sincronizando…" : "Sincronizar planilha"}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => copy(phone, "WhatsApp")}><MessageCircle className="size-4" /> Copiar WhatsApp</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => copy(email, "Email")}><Mail className="size-4" /> Copiar email</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => copy(reservationMessage(fullName, publicCode), "Mensagem com código")}><RotateCcw className="size-4" /> Reenviar código</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => copy(publicCode, "Código da reserva")}><Copy className="size-4" /> Copiar código</Button>
        {checkoutUrl ? <a href={checkoutUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-semibold text-forest hover:bg-mist"><ExternalLink className="size-4" /> Reenviar checkout</a> : null}
        {showMessageButton ? <Button type="button" size="sm" onClick={openWhatsappDraft}><MessageCircle className="size-4" /> Enviar mensagem</Button> : null}
      </div>

      <ConfirmationDialog
        open={action === "confirm"}
        title="Confirmar pagamento manualmente?"
        description="A reserva será confirmada somente se houver capacidade. Esta ação não executa cobrança nem conciliação no gateway."
        confirmLabel="Confirmar pagamento"
        requireReason
        onClose={() => setAction(null)}
        onConfirm={executeAction}
      />
      <ConfirmationDialog
        open={action === "cancel"}
        title="Cancelar esta reserva?"
        description="A vaga será liberada. Pagamentos já realizados não são estornados automaticamente e precisam de tratamento operacional."
        confirmLabel="Cancelar reserva"
        requireReason
        onClose={() => setAction(null)}
        onConfirm={executeAction}
      />
    </>
  );
}
