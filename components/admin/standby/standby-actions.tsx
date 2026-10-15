"use client";

/**
 * Ações de uma reserva em Stand-by: reagendar, desfazer, gerar e revogar link.
 *
 * O link individual é o único dado sensível que passa por aqui. Ele chega uma
 * vez, na resposta da geração, fica apenas no estado deste componente enquanto
 * o aviso está aberto e some quando o admin o fecha — não vai para a URL, para
 * o armazenamento do navegador nem para o console.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarClock, Copy, Link2, Link2Off, MessageCircle, Undo2, X } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { RescheduleStandbyDialog, UndoStandbyDialog } from "@/components/admin/standby/standby-dialogs";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { standbyLinkMessage } from "@/lib/admin/standby";

type Open = "reschedule" | "undo" | "generate" | "revoke" | null;
type LinkPayload = { url?: string; message?: string; selfServiceEnabled?: boolean };

export function StandbyActions({ reservationId, fullName, phone, publicCode, hasActiveLink }: {
  reservationId: string;
  fullName: string;
  phone: string;
  publicCode: string;
  hasActiveLink: boolean;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [selfServiceEnabled, setSelfServiceEnabled] = useState(false);

  const generateLink = async () => {
    const response = await fetch(`/api/admin/reservations/${reservationId}/standby/link`, { method: "POST" });
    const payload = await response.json().catch(() => ({})) as LinkPayload;
    if (!response.ok || !payload.url) throw new Error(payload.message ?? "Não foi possível gerar o link.");
    setLinkUrl(payload.url);
    setSelfServiceEnabled(payload.selfServiceEnabled === true);
    setOpen(null);
    router.refresh();
  };

  const revokeLink = async () => {
    const response = await fetch(`/api/admin/reservations/${reservationId}/standby/link`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({})) as LinkPayload;
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível revogar o link.");
    notify({ title: "Link revogado", description: "O link que estava com o cliente deixou de funcionar." });
    setOpen(null);
    router.refresh();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(linkUrl);
      notify({ title: "Link copiado" });
    } catch {
      notify({ title: "Não foi possível copiar", description: "Selecione o link manualmente.", variant: "error" });
    }
  };

  const openWhatsapp = () => {
    const digits = phone.replace(/\D/g, "");
    const message = standbyLinkMessage(fullName, publicCode, linkUrl, selfServiceEnabled);
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
    notify({ title: "Mensagem preparada", description: "Revise o texto no WhatsApp antes de enviar." });
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => setOpen("reschedule")}><CalendarClock className="size-4" /> Reagendar</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen("undo")}><Undo2 className="size-4" /> Desfazer Stand-by</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen("generate")}>
          <Link2 className="size-4" /> {hasActiveLink ? "Gerar novo link" : "Gerar link"}
        </Button>
        {hasActiveLink ? (
          <Button type="button" size="sm" variant="ghost" className="text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setOpen("revoke")}>
            <Link2Off className="size-4" /> Revogar link
          </Button>
        ) : null}
      </div>

      <RescheduleStandbyDialog open={open === "reschedule"} reservationId={reservationId} onClose={() => setOpen(null)} />
      <UndoStandbyDialog open={open === "undo"} reservationId={reservationId} onClose={() => setOpen(null)} />

      <ConfirmationDialog
        open={open === "generate"}
        title={hasActiveLink ? "Gerar um novo link?" : "Gerar link individual?"}
        description={hasActiveLink
          ? "O link anterior deixa de funcionar na hora, mesmo que já tenha sido enviado ao cliente. O novo link aparece uma única vez, para você copiar e compartilhar."
          : "O link é pessoal desta reserva e aparece uma única vez, para você copiar e compartilhar com o cliente. Nenhuma mensagem é enviada automaticamente."}
        confirmLabel={hasActiveLink ? "Gerar novo link" : "Gerar link"}
        tone="neutral"
        onClose={() => setOpen(null)}
        onConfirm={generateLink}
      />
      <ConfirmationDialog
        open={open === "revoke"}
        title="Revogar o link?"
        description="O link que está com o cliente para de funcionar imediatamente. A reserva continua em Stand-by e você pode gerar outro link depois."
        confirmLabel="Revogar link"
        onClose={() => setOpen(null)}
        onConfirm={revokeLink}
      />

      {linkUrl ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/55 p-4 backdrop-blur-sm" role="presentation">
          <div className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-soft sm:p-8" role="dialog" aria-modal="true" aria-labelledby="standby-link-title">
            <div className="flex items-start justify-between gap-4">
              <div className="grid size-11 place-items-center rounded-2xl bg-lake/10 text-lake"><Link2 className="size-5" /></div>
              <button type="button" onClick={() => setLinkUrl("")} className="grid size-9 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar">
                <X className="size-5" />
              </button>
            </div>
            <h2 id="standby-link-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">Link gerado</h2>
            <p className="mt-3 text-sm leading-6 text-ink/60">
              Copie agora: por segurança, este link <strong className="font-semibold text-ink">não será mostrado de novo</strong>. Se ele se perder, gere outro — o anterior deixa de valer.
            </p>
            <p className="mt-4 break-all rounded-2xl border border-ink/10 bg-mist/50 p-4 font-mono text-xs leading-5 text-ink">{linkUrl}</p>
            <p className="mt-3 text-xs leading-5 text-ink/50">
              {selfServiceEnabled
                ? "Com este link o cliente escolhe a nova data pelo site, entre as turmas com o mesmo valor por participante. A escolha vale uma vez."
                : "A escolha da nova data pelo próprio cliente não está ligada no site: por enquanto o link abre a página de acompanhamento da reserva."}
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={() => setLinkUrl("")}>Fechar</Button>
              <Button type="button" variant="outline" onClick={openWhatsapp}><MessageCircle className="size-4" /> Preparar WhatsApp</Button>
              <Button type="button" onClick={copyLink}><Copy className="size-4" /> Copiar link</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
