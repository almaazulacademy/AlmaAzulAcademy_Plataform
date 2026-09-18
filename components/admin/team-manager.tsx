"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Copy, Link2, MessageCircle, UserPlus } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { AdminEmptyState } from "@/components/admin/states";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { formatAdminDateTime } from "@/lib/admin/format";
import type { TeamInstructor, TeamInvite } from "@/lib/team/data";
import { cn } from "@/lib/utils";

const INVITE_LABELS: Record<TeamInvite["state"], { label: string; className: string }> = {
  VALID: { label: "Aguardando cadastro", className: "bg-sky-50 text-sky-800" },
  USED: { label: "Utilizado", className: "bg-emerald-50 text-emerald-800" },
  EXPIRED: { label: "Expirado", className: "bg-ink/5 text-ink/60" },
  REVOKED: { label: "Cancelado", className: "bg-ink/5 text-ink/60" },
  INVALID: { label: "Inválido", className: "bg-ink/5 text-ink/60" },
};

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "Não foi possível concluir agora.");
  return payload;
}

export function TeamManager({ instructors, invites }: { instructors: TeamInstructor[]; invites: TeamInvite[] }) {
  const router = useRouter();
  const { notify } = useToast();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [toggle, setToggle] = useState<TeamInstructor | null>(null);
  const [revoke, setRevoke] = useState<TeamInvite | null>(null);

  const createInvite = async () => {
    setCreating(true);
    try {
      const payload = await requestJson("/api/admin/team/invites", { method: "POST", body: "{}" });
      const invite = payload.invite as { url: string; expiresAt: string };
      setCreated(invite);
      setCopied(false);
      router.refresh();
    } catch (error) {
      notify({ title: "Convite não gerado", description: error instanceof Error ? error.message : "Tente novamente.", variant: "error" });
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      notify({ title: "Link copiado", description: "Cole no WhatsApp do instrutor." });
    } catch {
      notify({ title: "Não foi possível copiar", description: "Selecione o link e copie manualmente.", variant: "error" });
    }
  };

  const whatsappText = created
    ? `Olá! Este é o seu convite para acessar a Lista de Presença da Alma Azul Academy. Crie sua conta por este link (válido até ${formatAdminDateTime(created.expiresAt)}): ${created.url}`
    : "";

  return (
    <div className="mt-8 space-y-10">
      <section className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Convidar instrutor</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-ink/60">
              Gere um link de uso único, válido por 7 dias. Quem abrir o link cria o próprio e-mail e senha e passa a ver somente a Lista de Presença.
            </p>
          </div>
          <Button onClick={createInvite} disabled={creating} className="shrink-0">
            <UserPlus className="size-4" /> {creating ? "Gerando..." : "Gerar convite"}
          </Button>
        </div>

        {created ? (
          <div className="mt-6 rounded-2xl bg-mist/60 p-4 sm:p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Link2 className="size-4" /> Link do convite</p>
            <p className="mt-1 text-xs text-ink/55">
              Este link aparece só agora — por segurança ele não fica salvo. Válido até {formatAdminDateTime(created.expiresAt)}.
            </p>
            <input
              readOnly
              value={created.url}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Link do convite"
              className="mt-3 h-11 w-full rounded-2xl border border-ink/15 bg-white px-4 text-sm text-ink"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={copy}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copiado" : "Copiar link"}
              </Button>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(whatsappText)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-full border border-ink/20 px-4 text-sm font-semibold text-ink transition hover:border-ink hover:bg-ink hover:text-white"
              >
                <MessageCircle className="size-4" /> Enviar pelo WhatsApp
              </a>
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-ink">Instrutores</h2>
        {instructors.length === 0 ? (
          <div className="mt-4">
            <AdminEmptyState title="Nenhum instrutor cadastrado" description="Gere um convite e envie o link para o instrutor criar a conta." />
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-3xl border border-ink/10 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="hidden bg-mist/50 text-xs uppercase tracking-[0.12em] text-ink/55 md:table-header-group">
                <tr>
                  <th className="px-5 py-3 font-semibold">Nome / e-mail</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Criado em</th>
                  <th className="px-5 py-3 font-semibold">Último acesso</th>
                  <th className="px-5 py-3"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/10">
                {instructors.map((instructor) => (
                  <tr key={instructor.userId} className="grid gap-2 p-5 md:table-row md:p-0">
                    <td className="md:px-5 md:py-4">
                      <p className="font-semibold text-ink">{instructor.displayName}</p>
                      <p className="text-ink/55">{instructor.email}</p>
                    </td>
                    <td className="md:px-5 md:py-4">
                      <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", instructor.isActive ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800")}>
                        {instructor.isActive ? "Ativo" : "Desativado"}
                      </span>
                    </td>
                    <td className="text-ink/65 md:px-5 md:py-4"><span className="md:hidden">Criado em </span>{formatAdminDateTime(instructor.createdAt)}</td>
                    <td className="text-ink/65 md:px-5 md:py-4"><span className="md:hidden">Último acesso: </span>{instructor.lastSignInAt ? formatAdminDateTime(instructor.lastSignInAt) : "Nunca"}</td>
                    <td className="md:px-5 md:py-4 md:text-right">
                      <Button size="sm" variant="outline" onClick={() => setToggle(instructor)}>
                        {instructor.isActive ? "Desativar" : "Reativar"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {invites.length ? (
        <section>
          <h2 className="text-lg font-semibold text-ink">Convites recentes</h2>
          <ul className="mt-4 divide-y divide-ink/10 overflow-hidden rounded-3xl border border-ink/10 bg-white">
            {invites.map((invite) => {
              const state = INVITE_LABELS[invite.state];
              return (
                <li key={invite.inviteId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
                  <div>
                    <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", state.className)}>{state.label}</span>
                    <p className="mt-2 text-ink/65">
                      Gerado em {formatAdminDateTime(invite.createdAt)}
                      {invite.state === "USED" && invite.usedByName ? ` • usado por ${invite.usedByName}` : ` • válido até ${formatAdminDateTime(invite.expiresAt)}`}
                    </p>
                  </div>
                  {invite.state === "VALID" ? (
                    <Button size="sm" variant="ghost" onClick={() => setRevoke(invite)}>Cancelar convite</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <ConfirmationDialog
        open={Boolean(toggle)}
        title={toggle?.isActive ? "Desativar instrutor?" : "Reativar instrutor?"}
        description={toggle?.isActive
          ? `${toggle.displayName} perde o acesso à Lista de Presença imediatamente. A conta não é apagada e pode ser reativada.`
          : `${toggle?.displayName ?? ""} volta a acessar a Lista de Presença e o check-in.`}
        confirmLabel={toggle?.isActive ? "Desativar" : "Reativar"}
        tone={toggle?.isActive ? "danger" : "neutral"}
        onClose={() => setToggle(null)}
        onConfirm={async () => {
          if (!toggle) return;
          await requestJson(`/api/admin/team/instructors/${toggle.userId}`, { method: "PATCH", body: JSON.stringify({ active: !toggle.isActive }) });
          notify({ title: toggle.isActive ? "Instrutor desativado" : "Instrutor reativado", description: toggle.displayName });
          setToggle(null);
          router.refresh();
        }}
      />
      <ConfirmationDialog
        open={Boolean(revoke)}
        title="Cancelar convite?"
        description="O link deixa de funcionar imediatamente. Você pode gerar outro quando quiser."
        confirmLabel="Cancelar convite"
        onClose={() => setRevoke(null)}
        onConfirm={async () => {
          if (!revoke) return;
          await requestJson(`/api/admin/team/invites/${revoke.inviteId}`, { method: "DELETE" });
          notify({ title: "Convite cancelado", description: "O link não funciona mais." });
          setRevoke(null);
          router.refresh();
        }}
      />
    </div>
  );
}
