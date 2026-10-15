"use client";

/**
 * Autoatendimento do Stand-by: o cliente escolhe a nova data.
 *
 * Abre de dois jeitos — pelo link individual (`/acompanhar-reserva#r=<token>`)
 * ou pelo botão da consulta com CPF e código — e a credencial vai inteira a
 * cada chamada. A tela mostra o que o banco devolveu na abertura; quem aceita ou
 * recusa a escolha é a RPC, com a reserva e a turma travadas. Se as vagas
 * acabarem no meio do caminho, a recusa volta como mensagem e a lista é lida de
 * novo.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CalendarCheck2, CalendarClock, Check, Loader2, MessageCircle, Users, XCircle } from "lucide-react";

import { SessionTurma } from "@/components/reservation/session-turma";
import { Button } from "@/components/ui/button";
import { WHATSAPP_LINK } from "@/lib/contact";
import type { SelfServiceCredential, SelfServiceOverview } from "@/lib/reservations/standby-self-service";
import { groupSessionsByDay } from "@/lib/sessions/choice";
import { formatSessionDateShort, formatSessionTime } from "@/lib/sessions/date-time";

type OpenOverview = Extract<SelfServiceOverview, { state: "OPEN" }>;
type Rescheduled = { publicCode: string; startsAt: string; experienceTitle: string; quantity: number; baseName: string };
type Failure = { code: string; message: string };

function participantsLabel(quantity: number) {
  return `${quantity} ${quantity === 1 ? "participante" : "participantes"}`;
}

function turmaLabel(startsAt: string) {
  return `${formatSessionDateShort(startsAt)} · ${formatSessionTime(startsAt)}`;
}

function credentialBody(credential: SelfServiceCredential) {
  return credential.kind === "LINK" ? { token: credential.token } : { cpf: credential.cpf, publicCode: credential.publicCode };
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, payload };
}

function asFailure(payload: Record<string, unknown>): Failure {
  return {
    code: typeof payload.code === "string" ? payload.code : "FAILED",
    message: typeof payload.message === "string" ? payload.message : "Não foi possível consultar sua reserva agora.",
  };
}

function Panel({ icon, eyebrow, title, children }: { icon: ReactNode; eyebrow?: string; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl rounded-4xl bg-white p-7 sm:p-10">
      {icon}
      {eyebrow ? <p className="mt-7 text-xs font-semibold uppercase tracking-[0.18em] text-lake">{eyebrow}</p> : null}
      <h2 className="mt-4 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">{title}</h2>
      {children}
    </div>
  );
}

function TeamLink({ label = "Falar com a equipe" }: { label?: string }) {
  return (
    <a href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer" className="mt-7 inline-flex items-center gap-2 font-semibold text-forest">
      <MessageCircle className="size-4" /> {label}
    </a>
  );
}

export function StandbyReschedule({ credential, onUseLookup }: {
  credential: SelfServiceCredential;
  /** Volta para a consulta com CPF e código (link inválido, por exemplo). */
  onUseLookup?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<SelfServiceOverview | null>(null);
  const [loadFailure, setLoadFailure] = useState<Failure | null>(null);
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [selectedId, setSelectedId] = useState("");
  const [baseFilter, setBaseFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ rescheduled: Rescheduled; emailSent: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailure(null);
    try {
      const { ok, payload } = await post("/api/reservations/standby", { credential: credentialBody(credential) });
      if (!ok) {
        setLoadFailure(asFailure(payload));
        setOverview(null);
        return;
      }
      setOverview((payload.overview ?? null) as SelfServiceOverview | null);
    } catch {
      setLoadFailure({ code: "FAILED", message: "Não foi possível conectar ao sistema de reservas." });
    } finally {
      setLoading(false);
    }
  }, [credential]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !overview) {
    return (
      <div className="mx-auto flex max-w-2xl items-center gap-3 rounded-4xl bg-white p-7 text-ink/60 sm:p-10" role="status">
        <Loader2 className="size-5 animate-spin text-lake" /> Consultando sua reserva…
      </div>
    );
  }

  if (done) {
    const { rescheduled, emailSent } = done;
    return (
      <Panel icon={<CalendarCheck2 className="size-10 text-lake" />} eyebrow={`Reserva ${rescheduled.publicCode}`} title="Nova data confirmada.">
        <p className="mt-5 leading-7 text-ink/60">
          Sua reserva voltou a ficar confirmada, agora na turma abaixo. O código, o QR Code e o pagamento continuam os mesmos — não há nada a pagar.
        </p>
        <SessionTurma className="mt-7" startsAt={rescheduled.startsAt} experienceTitle={rescheduled.experienceTitle} label="Turma confirmada" />
        <p className="mt-5 flex items-center gap-2 text-sm font-semibold text-ink"><Users className="size-4 text-lake" /> {participantsLabel(rescheduled.quantity)}{rescheduled.baseName ? ` · ${rescheduled.baseName}` : ""}</p>
        <p className="mt-4 text-sm leading-6 text-ink/60">
          {emailSent
            ? "Enviamos a confirmação com a nova data para o e-mail da reserva."
            : "A nova data já vale. Você pode conferir a qualquer momento em Acompanhar reserva, com seu CPF e o código."}
        </p>
      </Panel>
    );
  }

  if (loadFailure) {
    const linkProblem = credential.kind === "LINK" && loadFailure.code === "NOT_FOUND";
    return (
      <Panel icon={<XCircle className="size-10 text-ink/35" />} title={loadFailure.code === "TOO_MANY_ATTEMPTS" ? "Muitas tentativas." : linkProblem ? "Link indisponível." : "Não foi possível abrir o reagendamento."}>
        <p role="alert" className="mt-5 leading-7 text-ink/60">{loadFailure.message}</p>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          {loadFailure.code === "UNAVAILABLE" || loadFailure.code === "FAILED" ? (
            <Button type="button" variant="outline" onClick={() => void load()}>Tentar de novo</Button>
          ) : null}
          {onUseLookup ? <Button type="button" variant="outline" onClick={onUseLookup}>Consultar com CPF e código</Button> : null}
        </div>
        <TeamLink />
      </Panel>
    );
  }

  if (!overview) return null;

  if (overview.state === "RESCHEDULED") {
    return (
      <Panel icon={<CalendarCheck2 className="size-10 text-lake" />} eyebrow={`Reserva ${overview.publicCode}`} title="Esta reserva já tem nova data.">
        <p className="mt-5 leading-7 text-ink/60">
          {overview.firstName ? `${overview.firstName}, a` : "A"} escolha da nova data já foi feita{overview.resolvedBy === "ADMIN" ? " com a nossa equipe" : ""} e a reserva está confirmada. Não é possível reagendar de novo por aqui.
        </p>
        {overview.session ? (
          <SessionTurma className="mt-7" startsAt={overview.session.startsAt} experienceTitle={overview.session.experienceTitle} label="Turma confirmada" />
        ) : null}
        <TeamLink label="Precisa mudar? Fale com a equipe" />
      </Panel>
    );
  }

  if (overview.state !== "OPEN") {
    const copy = {
      CANCELLED: { title: "Reserva cancelada.", text: "Esta reserva foi cancelada e não pode mais ser reagendada." },
      LINK_REPLACED: { title: "Este link não vale mais.", text: "A equipe gerou um acesso mais recente para esta reserva. Use o link novo ou consulte com seu CPF e o código." },
      CLOSED: { title: "Reagendamento encerrado.", text: "Esta reserva não está mais aguardando uma nova data." },
    }[overview.state];
    return (
      <Panel icon={<XCircle className="size-10 text-ink/35" />} eyebrow={`Reserva ${overview.publicCode}`} title={copy.title}>
        <p className="mt-5 leading-7 text-ink/60">{copy.text}</p>
        {overview.state === "LINK_REPLACED" && onUseLookup ? (
          <Button type="button" variant="outline" className="mt-7" onClick={onUseLookup}>Consultar com CPF e código</Button>
        ) : null}
        <TeamLink />
      </Panel>
    );
  }

  return (
    <OpenReschedule
      overview={overview}
      step={step}
      selectedId={selectedId}
      baseFilter={baseFilter}
      saving={saving}
      error={error}
      refreshing={loading}
      onSelect={(id) => { setSelectedId(id); setError(""); }}
      onBaseFilter={(value) => {
        setBaseFilter(value);
        const selected = overview.options.find((option) => option.sessionId === selectedId);
        // Uma escolha que sai da lista visível não pode continuar sendo o destino invisível da confirmação.
        if (value && selected && selected.baseSlug !== value) setSelectedId("");
      }}
      onStep={(next) => { setError(""); setStep(next); }}
      onConfirm={async () => {
        const selected = overview.options.find((option) => option.sessionId === selectedId);
        if (!selected) return;
        setSaving(true);
        setError("");
        try {
          const { ok, payload } = await post("/api/reservations/standby/reschedule", {
            credential: credentialBody(credential),
            standbyId: overview.standbyId,
            sessionId: selected.sessionId,
          });
          if (ok && payload.rescheduled && typeof payload.rescheduled === "object") {
            const result = payload.rescheduled as Omit<Rescheduled, "baseName">;
            setDone({ rescheduled: { ...result, baseName: selected.baseName }, emailSent: payload.emailSent === true });
            return;
          }
          const failure = asFailure(payload);
          setError(failure.message);
          // Vaga que acabou ou turma que fechou: a lista que está na tela já não
          // vale. Já reagendada: a tela passa a mostrar o estado novo.
          if (["NO_SPOTS", "SESSION_UNAVAILABLE", "ALREADY_USED", "NOT_FOUND"].includes(failure.code)) {
            setSelectedId("");
            setStep("select");
            await load();
          }
        } catch {
          setError("Não foi possível conectar ao sistema de reservas. Nada foi alterado.");
        } finally {
          setSaving(false);
        }
      }}
    />
  );
}

function OpenReschedule({
  overview,
  step,
  selectedId,
  baseFilter,
  saving,
  error,
  refreshing,
  onSelect,
  onBaseFilter,
  onStep,
  onConfirm,
}: {
  overview: OpenOverview;
  step: "select" | "confirm";
  selectedId: string;
  baseFilter: string;
  saving: boolean;
  error: string;
  refreshing: boolean;
  onSelect: (sessionId: string) => void;
  onBaseFilter: (baseSlug: string) => void;
  onStep: (step: "select" | "confirm") => void;
  onConfirm: () => Promise<void>;
}) {
  const options = overview.options;
  const selected = options.find((option) => option.sessionId === selectedId) ?? null;
  const bases = [...new Map(options.map((option) => [option.baseSlug, option.baseName])).entries()]
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const days = groupSessionsByDay(options.filter((option) => !baseFilter || option.baseSlug === baseFilter));

  return (
    <div className="mx-auto max-w-3xl rounded-4xl bg-white p-6 sm:p-10">
      <CalendarClock className="size-10 text-lake" />
      <p className="mt-7 text-xs font-semibold uppercase tracking-[0.18em] text-lake">Reserva {overview.publicCode}</p>
      <h2 className="mt-4 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">
        {step === "select" ? "Escolha a nova data." : "Confirmar a nova data?"}
      </h2>

      {step === "select" ? (
        <>
          <p className="mt-5 leading-7 text-ink/60">
            {overview.firstName ? `${overview.firstName}, sua` : "Sua"} reserva está paga e aguardando uma nova data. Escolha qualquer turma abaixo, de qualquer base: todas têm o mesmo valor por participante que você pagou e vagas para {participantsLabel(overview.quantity)}.
          </p>
          {overview.original.startsAt ? (
            <p className="mt-4 rounded-2xl bg-mist/60 p-4 text-sm leading-6 text-ink/60">
              <span className="font-semibold text-ink">Data anterior, que não vale mais:</span>{" "}
              {overview.original.experienceTitle}{overview.original.baseName ? ` · ${overview.original.baseName}` : ""} · {turmaLabel(overview.original.startsAt)}
            </p>
          ) : null}

          {bases.length > 1 ? (
            <div className="mt-7 flex flex-wrap gap-2" role="group" aria-label="Filtrar por base">
              <FilterChip active={!baseFilter} onClick={() => onBaseFilter("")}>Todas as bases</FilterChip>
              {bases.map((base) => (
                <FilterChip key={base.slug} active={baseFilter === base.slug} onClick={() => onBaseFilter(base.slug)}>{base.name}</FilterChip>
              ))}
            </div>
          ) : null}

          {error ? <p role="alert" className="mt-6 rounded-2xl bg-red-50 p-4 text-sm text-red-800">{error}</p> : null}

          {options.length === 0 ? (
            <div className="mt-7 rounded-2xl bg-mist/60 p-5 text-sm leading-6 text-ink/70">
              <p className="font-semibold text-ink">Nenhuma turma disponível agora.</p>
              <p className="mt-2">
                Não há, neste momento, turma futura e aberta com o mesmo valor por participante e vagas para {participantsLabel(overview.quantity)}.
                {overview.hiddenForCapacity > 0
                  ? ` ${overview.hiddenForCapacity === 1 ? "Uma turma do mesmo valor está" : `${overview.hiddenForCapacity} turmas do mesmo valor estão`} sem vagas suficientes para o grupo inteiro.`
                  : ""}{" "}
                Sua reserva continua paga e garantida: volte mais tarde ou fale com a equipe.
              </p>
              <TeamLink />
            </div>
          ) : (
            <fieldset className="mt-7" disabled={refreshing}>
              <legend className="sr-only">Nova turma</legend>
              <div className="space-y-6">
                {days.map((day) => (
                  <div key={day.dayKey}>
                    <p className="text-sm font-semibold text-ink first-letter:uppercase">{day.weekday}, {day.dayMonth}</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {day.turmas.map(({ session }) => {
                        const active = selectedId === session.sessionId;
                        return (
                          <label
                            key={session.sessionId}
                            className={`flex cursor-pointer items-start gap-3 rounded-3xl border p-4 transition ${
                              active ? "border-lake bg-lake/5 ring-2 ring-lake/20" : "border-ink/15 hover:border-lake/60"
                            }`}
                          >
                            <input
                              type="radio"
                              name="standby-new-session"
                              className="mt-1.5 size-4 accent-lake"
                              value={session.sessionId}
                              checked={active}
                              onChange={() => onSelect(session.sessionId)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-2xl font-medium tracking-[-0.04em] text-forest">{formatSessionTime(session.startsAt)}</span>
                              <span className="mt-1 block text-sm font-semibold text-ink">{session.experienceTitle}</span>
                              <span className="mt-0.5 block text-sm text-ink/60">{session.baseName}</span>
                              <span className="mt-2 block text-xs font-medium text-ink/55">
                                {session.remainingSpots} {session.remainingSpots === 1 ? "vaga restante" : "vagas restantes"}
                                {session.isOriginal ? " · sua turma original" : ""}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {days.length === 0 ? <p className="text-sm text-ink/60">Nenhuma turma desta base. Escolha outra base acima.</p> : null}
              </div>
              {overview.hiddenForCapacity > 0 ? (
                <p className="mt-5 text-xs leading-5 text-ink/50">
                  {overview.hiddenForCapacity === 1 ? "Uma turma do mesmo valor não aparece" : `${overview.hiddenForCapacity} turmas do mesmo valor não aparecem`} por não ter vagas para o grupo inteiro.
                </p>
              ) : null}
            </fieldset>
          )}

          {options.length > 0 ? (
            <Button type="button" size="lg" className="mt-8 w-full sm:w-auto" disabled={!selected || refreshing} onClick={() => onStep("confirm")}>
              Revisar nova data <ArrowRight className="size-4" />
            </Button>
          ) : null}
        </>
      ) : null}

      {step === "confirm" && selected ? (
        <>
          <SessionTurma className="mt-7" startsAt={selected.startsAt} experienceTitle={selected.experienceTitle} label="Nova turma" />
          <p className="mt-5 flex items-center gap-2 text-sm font-semibold text-ink"><Users className="size-4 text-lake" /> {participantsLabel(overview.quantity)} · {selected.baseName}</p>
          <ul className="mt-5 space-y-2 rounded-3xl bg-mist/60 p-5 text-sm leading-6 text-ink/70">
            <li className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-lake" /> A reserva volta a ficar confirmada, nesta turma.</li>
            <li className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-lake" /> O pagamento continua o mesmo: nada a pagar e nenhuma cobrança nova.</li>
            <li className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-lake" /> O código {overview.publicCode} e o QR Code continuam valendo, agora para a nova data.</li>
            <li className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-lake" /> A escolha vale uma vez: para mudar depois, só com a equipe.</li>
          </ul>
          {error ? <p role="alert" className="mt-6 rounded-2xl bg-red-50 p-4 text-sm text-red-800">{error}</p> : null}
          <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row">
            <Button type="button" variant="ghost" onClick={() => onStep("select")} disabled={saving}>Voltar</Button>
            <Button type="button" size="lg" onClick={() => void onConfirm()} disabled={saving}>
              {saving ? "Confirmando…" : "Confirmar nova data"}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
        active ? "border-forest bg-forest text-white" : "border-ink/15 text-ink/70 hover:border-forest/60"
      }`}
    >
      {children}
    </button>
  );
}
