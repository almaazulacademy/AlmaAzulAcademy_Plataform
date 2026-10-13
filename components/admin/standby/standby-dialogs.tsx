"use client";

/**
 * Modais do Stand-by: colocar em Stand-by, reagendar e desfazer.
 *
 * Os três mexem em uma reserva já paga, então cada um repete na tela o que vai
 * acontecer antes de pedir a confirmação — de onde a reserva sai, para onde vai,
 * quantas pessoas, e que o pagamento não muda. Nenhum deles é a autoridade: a
 * tela mostra o que o banco informou na abertura do modal, e quem aceita ou
 * recusa é a RPC, com a reserva e a sessão travadas.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CalendarClock, Check, PauseCircle, Undo2, Users, X } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass, textareaClass } from "@/components/admin/form-styles";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/admin/format";
import { rescheduleEmailNotice, restoreRejectionMessage, type StandbyOption, type StandbyOptions } from "@/lib/admin/standby";
import { groupSessionsByDay } from "@/lib/sessions/choice";
import { formatSessionDateShort, formatSessionTime } from "@/lib/sessions/date-time";

type ApiPayload = { message?: string; email?: { outcome?: string } };

function turmaLabel(startsAt: string) {
  return `${formatSessionDateShort(startsAt)} · ${formatSessionTime(startsAt)}`;
}

function participantsLabel(quantity: number) {
  return `${quantity} ${quantity === 1 ? "participante" : "participantes"}`;
}

/** Moldura comum: fundo, Escape, trava de rolagem e botão de fechar. */
function Modal({ titleId, icon, busy, onClose, children }: {
  titleId: string;
  icon: ReactNode;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-ink/55 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-soft sm:p-8" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-4">
          <div className="grid size-11 place-items-center rounded-2xl bg-lake/10 text-lake">{icon}</div>
          <button type="button" onClick={onClose} disabled={busy} className="grid size-9 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink/45">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

// --- Colocar em Stand-by ------------------------------------------------------

export type StandbyEntrySummary = {
  experienceTitle: string;
  startsAt: string;
  quantity: number;
  totalCents: number;
  /** Presença parcial ou completa já registrada: o banco recusa a entrada. */
  checkinBlocked?: boolean;
};

export function SetStandbyDialog({ open, reservationId, fullName, publicCode, summary, onClose }: {
  open: boolean;
  reservationId: string;
  fullName: string;
  publicCode: string;
  summary: StandbyEntrySummary;
  onClose: () => void;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) return;
    setReason("");
    setConfirmed(false);
    setError("");
    setSaving(false);
  }, [open]);

  if (!open) return null;

  const blocked = summary.checkinBlocked === true;

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError("Informe um motivo com pelo menos 3 caracteres.");
      return;
    }
    if (!confirmed) {
      setError("Marque a confirmação para continuar.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/reservations/${reservationId}/standby`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), confirmed: true }),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) throw new Error(payload.message ?? "Não foi possível colocar a reserva em Stand-by.");
      notify({
        title: "Reserva em Stand-by",
        description: `A reserva saiu da turma de ${turmaLabel(summary.startsAt)} e ${summary.quantity === 1 ? "1 vaga foi liberada" : `${summary.quantity} vagas foram liberadas`}. O pagamento não foi alterado.`,
      });
      onClose();
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível colocar a reserva em Stand-by.");
      setSaving(false);
    }
  };

  return (
    <Modal titleId="set-standby-title" icon={<PauseCircle className="size-5" />} busy={saving} onClose={onClose}>
      <h2 id="set-standby-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">Colocar em Stand-by?</h2>
      <p className="mt-3 text-sm leading-6 text-ink/60">
        A reserva sai da turma atual e fica aguardando reagendamento. Ela continua paga, com o mesmo código e o mesmo QR Code.
      </p>

      <dl className="mt-5 grid gap-4 rounded-2xl border border-ink/10 bg-mist/50 p-4 sm:grid-cols-2">
        <Fact label="Cliente" value={fullName} />
        <Fact label="Código da reserva" value={publicCode} />
        <Fact label="Experiência" value={summary.experienceTitle} />
        <Fact label="Turma original" value={turmaLabel(summary.startsAt)} />
        <Fact label="Participantes" value={String(summary.quantity)} />
        <Fact label="Valor pago" value={formatCurrency(summary.totalCents)} />
      </dl>

      {blocked ? (
        <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">
          Esta reserva já tem presença registrada. Desfaça o check-in na Lista de Presença antes de colocá-la em Stand-by.
        </p>
      ) : (
        <>
          <p className="mt-5 rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            <strong className="font-semibold">
              {summary.quantity === 1 ? "A vaga desta reserva será liberada" : `As ${summary.quantity} vagas desta reserva serão liberadas`} na turma original.
            </strong>{" "}
            Elas voltam a ficar disponíveis para venda. Para devolver a reserva a esta turma depois, ela precisará estar aberta, no futuro e com vagas.
          </p>

          <label className="mt-5 block">
            <span className={labelClass}>Motivo do Stand-by</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className={textareaClass}
              maxLength={500}
              disabled={saving}
              placeholder="Ex.: turma cancelada por mau tempo"
            />
            <span className="mt-1.5 block text-xs text-ink/40">Fica no histórico administrativo. Não aparece no site nem para o cliente.</span>
          </label>

          <label className="mt-4 flex items-start gap-3 text-sm text-ink/80">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-lake"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={saving}
            />
            <span>Confirmo que esta reserva deve sair da turma original e que as vagas dela serão liberadas.</span>
          </label>
        </>
      )}

      {error ? <p className={fieldErrorClass} role="alert">{error}</p> : null}

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Voltar</Button>
        {blocked ? null : (
          <Button type="button" onClick={submit} disabled={saving || !confirmed}>
            {saving ? "Processando…" : "Colocar em Stand-by"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// --- Leitura da situação do Stand-by -----------------------------------------

function useStandbyOptions(open: boolean, reservationId: string) {
  const [data, setData] = useState<StandbyOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!open) {
      setData(null);
      setLoadError("");
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError("");
    fetch(`/api/admin/reservations/${reservationId}/standby`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as StandbyOptions & ApiPayload | null;
        if (!active) return;
        if (!response.ok || !payload || !("standbyId" in payload)) {
          setLoadError(payload?.message ?? "Não foi possível carregar a situação do Stand-by.");
          return;
        }
        setData(payload);
      })
      .catch(() => {
        if (active) setLoadError("Não foi possível carregar a situação do Stand-by.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, reservationId]);

  return { data, loading, loadError };
}

function OriginalTurma({ data }: { data: StandbyOptions }) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-mist/50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Turma original</p>
      <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-ink">{turmaLabel(data.original.startsAt)}</p>
      <p className="mt-1 text-sm text-ink/60">
        {data.original.experienceTitle}{data.original.baseName ? ` · ${data.original.baseName}` : ""}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink/60">
        <span className="inline-flex items-center gap-1.5"><Users className="size-4 text-lake" /> {participantsLabel(data.quantity)}</span>
        <span aria-hidden>·</span>
        <span>{formatCurrency(data.totalCents)} pagos ({formatCurrency(data.unitPriceCents)} por participante)</span>
      </p>
    </div>
  );
}

// --- Reagendar ----------------------------------------------------------------

export function RescheduleStandbyDialog({ open, reservationId, onClose }: {
  open: boolean;
  reservationId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const { data, loading, loadError } = useStandbyOptions(open, reservationId);
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [selectedId, setSelectedId] = useState("");
  const [baseFilter, setBaseFilter] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) return;
    setStep("select");
    setSelectedId("");
    setBaseFilter("");
    setReason("");
    setError("");
    setSaving(false);
  }, [open]);

  if (!open) return null;

  const options: StandbyOption[] = data?.options ?? [];
  const selected = options.find((option) => option.sessionId === selectedId) ?? null;
  const bases = [...new Map(options.map((option) => [option.baseId, option.baseName])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const days = groupSessionsByDay(options.filter((option) => !baseFilter || option.baseId === baseFilter));

  const submit = async () => {
    if (!data || !selected) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/reservations/${reservationId}/standby/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetSessionId: selected.sessionId, reason: reason.trim() }),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) throw new Error(payload.message ?? "Não foi possível reagendar a reserva.");
      notify({
        title: "Reserva reagendada",
        description: `A reserva passou para ${selected.experienceTitle} · ${turmaLabel(selected.startsAt)}. ${rescheduleEmailNotice(payload.email?.outcome)}`,
      });
      onClose();
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível reagendar a reserva.");
      setSaving(false);
    }
  };

  return (
    <Modal titleId="reschedule-standby-title" icon={<CalendarClock className="size-5" />} busy={saving} onClose={onClose}>
      <h2 id="reschedule-standby-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">
        {step === "select" ? "Reagendar reserva" : "Confirmar reagendamento?"}
      </h2>

      {loading ? <p className="mt-4 text-sm text-ink/50">Carregando turmas…</p> : null}
      {loadError ? <p className="mt-4 text-sm text-red-700" role="alert">{loadError}</p> : null}

      {data && step === "select" ? (
        <div className="mt-5 space-y-5">
          <OriginalTurma data={data} />

          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Nova turma</legend>
            <p className="mt-2 text-sm text-ink/50">
              Só aparecem turmas abertas, futuras e publicadas, com vagas para {participantsLabel(data.quantity)} e preço de exatamente{" "}
              {formatCurrency(data.unitPriceCents)} por participante — de qualquer base.
              {data.hiddenForCapacity > 0
                ? ` ${data.hiddenForCapacity} ${data.hiddenForCapacity === 1 ? "turma do mesmo valor ficou" : "turmas do mesmo valor ficaram"} de fora por não ter vagas suficientes.`
                : ""}
            </p>

            {bases.length > 1 ? (
              <label className="mt-3 block">
                <span className="sr-only">Filtrar por base</span>
                <select
                  value={baseFilter}
                  onChange={(event) => {
                    const value = event.target.value;
                    setBaseFilter(value);
                    // Uma seleção que sai da lista visível não pode continuar
                    // sendo o destino invisível da confirmação.
                    if (value && selected && selected.baseId !== value) setSelectedId("");
                  }}
                  className={inputClass}
                >
                  <option value="">Todas as bases ({options.length} {options.length === 1 ? "turma" : "turmas"})</option>
                  {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
                </select>
              </label>
            ) : null}

            {days.length === 0 ? (
              <p className="mt-3 rounded-2xl bg-mist/50 p-4 text-sm text-ink/60">
                {options.length === 0
                  ? `Nenhuma turma futura e aberta de ${formatCurrency(data.unitPriceCents)} por participante tem vagas para ${participantsLabel(data.quantity)}. A reserva continua em Stand-by até existir uma data elegível.`
                  : "Nenhuma turma desta base está disponível. Escolha outra base no filtro."}
              </p>
            ) : (
              <div className="mt-3 space-y-5">
                {days.map((day) => (
                  <div key={day.dayKey}>
                    <p className="text-sm font-semibold capitalize text-ink">{day.weekday}, {day.dayMonth}</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {day.turmas.map(({ session }) => {
                        const active = selectedId === session.sessionId;
                        return (
                          <label
                            key={session.sessionId}
                            className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${
                              active ? "border-lake bg-lake/5 ring-2 ring-lake/20" : "border-ink/15 hover:border-lake/60"
                            }`}
                          >
                            <input
                              type="radio"
                              name="standby-target-session"
                              className="mt-1.5 size-4 accent-lake"
                              value={session.sessionId}
                              checked={active}
                              onChange={() => setSelectedId(session.sessionId)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold text-lake">
                                {session.experienceTitle}
                                {session.isOriginal ? (
                                  <span className="ml-1.5 rounded-full bg-lake/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-lake">turma original</span>
                                ) : null}
                              </span>
                              <span className="mt-1 block text-xl font-semibold tracking-[-0.02em] text-ink">{formatSessionTime(session.startsAt)}</span>
                              <span className="mt-0.5 block text-sm text-ink/60">{formatSessionDateShort(session.startsAt)} · {session.baseName}</span>
                              <span className="mt-2 block text-xs font-medium text-ink/60">
                                {session.remainingSpots} {session.remainingSpots === 1 ? "vaga restante" : "vagas restantes"} de {session.capacity}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          <label className="block">
            <span className={labelClass}>Motivo do reagendamento (opcional)</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} className={textareaClass} maxLength={500} placeholder="Ex.: cliente escolheu a nova data por telefone" />
            <span className="mt-1.5 block text-xs text-ink/40">Fica no histórico administrativo. Não aparece no site nem para o cliente.</span>
          </label>
        </div>
      ) : null}

      {data && step === "confirm" && selected ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="rounded-2xl border border-ink/10 bg-mist/50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Turma original</p>
              <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-ink">{turmaLabel(data.original.startsAt)}</p>
              <p className="mt-1 text-sm text-ink/60">{data.original.experienceTitle}{data.original.baseName ? ` · ${data.original.baseName}` : ""}</p>
            </div>
            <ArrowRight className="mx-auto hidden size-5 text-lake sm:block" aria-hidden />
            <div className="rounded-2xl border border-lake/40 bg-lake/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Nova turma</p>
              <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-ink">{turmaLabel(selected.startsAt)}</p>
              <p className="mt-1 text-sm text-ink/60">{selected.experienceTitle} · {selected.baseName}</p>
            </div>
          </div>
          <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Users className="size-4 text-lake" /> {participantsLabel(data.quantity)}</p>
          <ul className="space-y-2 rounded-2xl bg-mist/50 p-4 text-sm text-ink/70">
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> A reserva volta a ficar confirmada, na nova turma.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> O pagamento não muda: {formatCurrency(data.totalCents)} permanecem como pagos e nenhuma cobrança é gerada.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> O código {data.publicCode} e o QR Code são os mesmos.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> {data.rescheduleEmailEnabled
              ? "O cliente recebe um e-mail de confirmação com a nova data, o mesmo código e o mesmo QR Code."
              : "Nenhum e-mail é enviado por esta ação: avise o cliente."}</li>
          </ul>
          {reason.trim() ? <p className="text-sm text-ink/60"><span className="font-semibold text-ink">Motivo:</span> {reason.trim()}</p> : null}
        </div>
      ) : null}

      {error ? <p className={fieldErrorClass} role="alert">{error}</p> : null}

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {step === "confirm" ? (
          <Button type="button" variant="ghost" onClick={() => setStep("select")} disabled={saving}>Voltar</Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
        )}
        {step === "select" ? (
          <Button type="button" onClick={() => { setError(""); setStep("confirm"); }} disabled={!selected}>Revisar reagendamento</Button>
        ) : (
          <Button type="button" onClick={submit} disabled={saving}>{saving ? "Reagendando…" : "Confirmar reagendamento"}</Button>
        )}
      </div>
    </Modal>
  );
}

// --- Desfazer -----------------------------------------------------------------

export function UndoStandbyDialog({ open, reservationId, onClose }: {
  open: boolean;
  reservationId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const { data, loading, loadError } = useStandbyOptions(open, reservationId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) return;
    setReason("");
    setError("");
    setSaving(false);
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!data) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/reservations/${reservationId}/standby/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) throw new Error(payload.message ?? "Não foi possível desfazer o Stand-by.");
      notify({
        title: "Stand-by desfeito",
        description: `A reserva voltou para a turma de ${turmaLabel(data.original.startsAt)}. O pagamento não foi alterado.`,
      });
      onClose();
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível desfazer o Stand-by.");
      setSaving(false);
    }
  };

  return (
    <Modal titleId="undo-standby-title" icon={<Undo2 className="size-5" />} busy={saving} onClose={onClose}>
      <h2 id="undo-standby-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">Desfazer Stand-by?</h2>

      {loading ? <p className="mt-4 text-sm text-ink/50">Conferindo a turma original…</p> : null}
      {loadError ? <p className="mt-4 text-sm text-red-700" role="alert">{loadError}</p> : null}

      {data ? (
        <div className="mt-5 space-y-5">
          <OriginalTurma data={data} />
          {data.restore.allowed ? (
            <>
              <p className="text-sm leading-6 text-ink/60">
                A reserva volta a ficar confirmada na turma original e passa a ocupar {data.quantity === 1 ? "1 vaga" : `${data.quantity} vagas`} nela
                ({data.restore.remainingSpots} {data.restore.remainingSpots === 1 ? "vaga disponível" : "vagas disponíveis"} agora). O pagamento, o código e o QR Code não mudam.
              </p>
              <label className="block">
                <span className={labelClass}>Motivo (opcional)</span>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} className={textareaClass} maxLength={500} placeholder="Ex.: Stand-by criado por engano" />
              </label>
            </>
          ) : (
            <p className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-800" role="alert">
              {restoreRejectionMessage(data.restore.rejection)} Não é possível desfazer: use &ldquo;Reagendar&rdquo; para escolher outra turma.
            </p>
          )}
        </div>
      ) : null}

      {error ? <p className={fieldErrorClass} role="alert">{error}</p> : null}

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Voltar</Button>
        {data?.restore.allowed ? (
          <Button type="button" onClick={submit} disabled={saving}>{saving ? "Processando…" : "Desfazer Stand-by"}</Button>
        ) : null}
      </div>
    </Modal>
  );
}
