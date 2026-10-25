"use client";

/**
 * Saída da lista de espera pelo link do e-mail (`/lista-de-espera#t=<token>`).
 *
 * O token vem do fragmento — que o navegador não envia ao servidor — e viaja só
 * no corpo de um POST. Ver e cancelar são dois passos: um leitor de e-mail que
 * abre o link sozinho nunca tira ninguém da lista.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { BellOff, Check, Loader2, XCircle } from "lucide-react";

import { SessionTurma } from "@/components/reservation/session-turma";
import { Button } from "@/components/ui/button";
import { waitlistTokenFromHash } from "@/lib/waitlist/signup";

type Overview = {
  state: string;
  firstName: string;
  quantity: number;
  session: { startsAt: string; experienceTitle: string; baseName: string };
};

type View =
  | { kind: "LOADING" }
  | { kind: "INVALID"; message: string }
  | { kind: "ERROR"; message: string }
  | { kind: "ACTIVE"; overview: Overview }
  | { kind: "CLOSED"; overview: Overview | null; message: string };

const CLOSED_COPY: Record<string, string> = {
  CANCELLED: "Você já saiu da lista de espera desta turma.",
  REMOVED: "Esta inscrição foi encerrada pela nossa equipe.",
  CONVERTED: "Você já tem uma reserva nesta turma. A inscrição na lista de espera foi encerrada.",
  EXPIRED: "Esta turma já aconteceu ou não está mais aberta. A inscrição foi encerrada.",
};

async function post(path: string, token: string) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
}

function messageOf(payload: Record<string, unknown>, fallback: string) {
  return typeof payload.message === "string" ? payload.message : fallback;
}

export function WaitlistCancel() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "LOADING" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const found = waitlistTokenFromHash(window.location.hash);
    if (!found) {
      setView({ kind: "INVALID", message: "Este link não é válido. Abra o link direto do e-mail de confirmação." });
      return;
    }
    setToken(found);
    // Tira o token da barra de endereço: ele não vai para o histórico nem é
    // copiado sem querer ao compartilhar a página.
    window.history.replaceState(null, "", window.location.pathname);
    post("/api/waitlist/cancel/overview", found)
      .then(({ ok, status, payload }) => {
        if (status === 404) return setView({ kind: "INVALID", message: messageOf(payload, "Este link não é válido.") });
        if (!ok) return setView({ kind: "ERROR", message: messageOf(payload, "Não foi possível abrir o link agora. Tente novamente em instantes.") });
        const overview = payload as unknown as Overview;
        if (overview.state === "ACTIVE") return setView({ kind: "ACTIVE", overview });
        setView({ kind: "CLOSED", overview, message: CLOSED_COPY[overview.state] ?? "Esta inscrição já não está ativa." });
      })
      .catch(() => setView({ kind: "ERROR", message: "Não foi possível conectar. Verifique sua internet e tente novamente." }));
  }, []);

  async function confirm() {
    if (!token || view.kind !== "ACTIVE") return;
    setPending(true);
    try {
      const { ok, payload } = await post("/api/waitlist/cancel", token);
      if (!ok) { setView({ kind: "ERROR", message: messageOf(payload, "Não foi possível sair da lista agora. Tente novamente.") }); return; }
      const state = typeof payload.state === "string" ? payload.state : "CANCELLED";
      setView({ kind: "CLOSED", overview: view.overview, message: state === "CANCELLED" ? messageOf(payload, CLOSED_COPY.CANCELLED) : CLOSED_COPY[state] ?? messageOf(payload, "Esta inscrição já não está ativa.") });
    } catch {
      setView({ kind: "ERROR", message: "Não foi possível conectar. Verifique sua internet e tente novamente." });
    } finally {
      setPending(false);
    }
  }

  if (view.kind === "LOADING") {
    return <div className="mx-auto flex max-w-2xl items-center gap-3 rounded-4xl bg-white p-10 text-ink/60" role="status"><Loader2 aria-hidden="true" className="size-5 animate-spin" />Abrindo sua inscrição…</div>;
  }

  if (view.kind === "INVALID" || view.kind === "ERROR") {
    return (
      <div className="mx-auto max-w-2xl rounded-4xl bg-white p-7 text-center sm:p-12" role="alert">
        <XCircle aria-hidden="true" className="mx-auto size-8 text-ink/40" />
        <h1 className="mt-5 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">{view.kind === "INVALID" ? "Link indisponível" : "Algo não saiu como esperado"}</h1>
        <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/60">{view.message}</p>
        <Link href="/agenda" className="mt-7 inline-flex font-semibold text-forest">Ver a agenda</Link>
      </div>
    );
  }

  const overview = view.overview;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {overview?.session.startsAt ? <SessionTurma startsAt={overview.session.startsAt} experienceTitle={overview.session.experienceTitle} label="Lista de espera da turma" /> : null}
      <div className="rounded-4xl bg-white p-7 sm:p-10" role={view.kind === "CLOSED" ? "status" : undefined}>
        {view.kind === "ACTIVE" ? (
          <>
            <span className="grid size-12 place-items-center rounded-2xl bg-mist text-lake"><BellOff aria-hidden="true" className="size-6" /></span>
            <h1 className="mt-6 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">Sair da lista de espera?</h1>
            <p className="mt-4 leading-7 text-ink/65">
              {view.overview.firstName ? `${view.overview.firstName}, você` : "Você"} está na lista de espera desta turma{view.overview.quantity > 1 ? `, para ${view.overview.quantity} pessoas` : ""}. Ao sair, não enviaremos mais avisos sobre ela. Nenhuma reserva ou pagamento é afetado.
            </p>
            <Button type="button" size="lg" className="mt-7 w-full sm:w-auto" disabled={pending} onClick={confirm}>
              {pending ? <><Loader2 aria-hidden="true" className="size-4 animate-spin" />Saindo...</> : "Sim, sair da lista de espera"}
            </Button>
          </>
        ) : (
          <>
            <span className="grid size-12 place-items-center rounded-2xl bg-mist text-lake"><Check aria-hidden="true" className="size-6" /></span>
            <h1 className="mt-6 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">Inscrição encerrada</h1>
            <p className="mt-4 leading-7 text-ink/65">{view.message}</p>
            <Link href="/agenda" className="mt-7 inline-flex font-semibold text-forest">Ver a agenda</Link>
          </>
        )}
      </div>
    </div>
  );
}
