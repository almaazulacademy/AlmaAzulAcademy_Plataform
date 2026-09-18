"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Minus, Plus, RotateCcw, ScanLine, UserCheck, X } from "lucide-react";

import { QrScanner } from "@/components/admin/attendance/qr-scanner";
import type { AttendanceReservation, AttendanceSession, CheckinMethod, CheckinReservation } from "@/lib/checkin/parse";
import { attendanceTotals, PRESENCE_LABELS, presenceState, type PresenceState } from "@/lib/checkin/token";
import { formatSessionDateShort, formatSessionTime } from "@/lib/sessions/date-time";
import { cn } from "@/lib/utils";

type Sheet =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "wrongSession"; reservation: CheckinReservation }
  | { kind: "notConfirmed"; reservation: CheckinReservation }
  | { kind: "already"; reservation: CheckinReservation; method: CheckinMethod }
  | { kind: "form"; reservation: CheckinReservation; method: CheckinMethod; editing: boolean }
  | { kind: "success"; reservation: CheckinReservation; method: CheckinMethod; undone: boolean };

type ApiError = { code?: string; message?: string };

const STATE_STYLES: Record<PresenceState, { icon: string; badge: string; row: string }> = {
  COMPLETE: { icon: "✅", badge: "bg-emerald-100 text-emerald-900", row: "border-emerald-200 bg-emerald-50/60" },
  PARTIAL: { icon: "🟠", badge: "bg-orange-100 text-orange-900", row: "border-orange-200 bg-orange-50/60" },
  WAITING: { icon: "🟡", badge: "bg-amber-100 text-amber-900", row: "border-ink/10 bg-white" },
  ABSENT: { icon: "⚪", badge: "bg-slate-200 text-slate-800", row: "border-slate-200 bg-slate-50" },
};

function vagas(quantity: number) {
  return `${quantity} ${quantity === 1 ? "vaga" : "vagas"}`;
}

function presentes(count: number) {
  return `${count} ${count === 1 ? "presente" : "presentes"}`;
}

function timeOf(value: string | null) {
  return value ? formatSessionTime(value) : "";
}

// Onde a Lista de Presença está montada: painel (/admin/presenca) ou área do
// instrutor (/instrutor). Os links internos do quadro seguem o mesmo lugar.
const BasePathContext = createContext("/admin/presenca");

export function AttendanceBoard({ session, initialToken, basePath = "/admin/presenca" }: {
  session: AttendanceSession;
  initialToken: string | null;
  basePath?: string;
}) {
  return (
    <BasePathContext.Provider value={basePath}>
      <AttendanceBoardContent session={session} initialToken={initialToken} />
    </BasePathContext.Provider>
  );
}

function AttendanceBoardContent({ session, initialToken }: { session: AttendanceSession; initialToken: string | null }) {
  const basePath = useContext(BasePathContext);
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const totals = attendanceTotals(session.reservations);

  const asCheckinReservation = useCallback((row: AttendanceReservation): CheckinReservation => ({
    ...row,
    status: "CONFIRMED",
    email: "",
    sessionId: session.sessionId,
    experienceTitle: session.experienceTitle,
    startsAt: session.startsAt,
    hasToken: true,
  }), [session.experienceTitle, session.sessionId, session.startsAt]);

  /** Decide a tela depois de identificar a reserva. Nunca marca presença sozinho. */
  const present = useCallback((reservation: CheckinReservation, method: CheckinMethod) => {
    if (reservation.status !== "CONFIRMED") return setSheet({ kind: "notConfirmed", reservation });
    if (reservation.sessionId !== session.sessionId) return setSheet({ kind: "wrongSession", reservation });
    if (reservation.checkedInCount !== null) return setSheet({ kind: "already", reservation, method });
    setSheet({ kind: "form", reservation, method, editing: false });
  }, [session.sessionId]);

  const lookup = useCallback(async (query: string, method: CheckinMethod) => {
    setSheet({ kind: "loading" });
    try {
      const response = await fetch(`/api/admin/checkin/lookup?${query}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as ApiError & { reservation?: CheckinReservation };
      if (!response.ok || !payload.reservation) {
        setSheet({ kind: "error", message: payload.message ?? "Não foi possível identificar este QR Code." });
        return;
      }
      present(payload.reservation, method);
    } catch {
      setSheet({ kind: "error", message: "Sem conexão. Confira a internet e tente de novo." });
    }
  }, [present]);

  // QR lido pela câmera nativa: a página chega com ?qr=<token>.
  const handledInitial = useRef(false);
  useEffect(() => {
    if (!initialToken || handledInitial.current) return;
    handledInitial.current = true;
    // Tira o ?qr= da barra sem recarregar: um F5 não reabre a mesma leitura.
    window.history.replaceState(null, "", window.location.pathname);
    void lookup(`code=${encodeURIComponent(initialToken)}`, "QR");
  }, [initialToken, lookup]);

  const onScan = useCallback((text: string) => {
    setScanning(false);
    void lookup(`code=${encodeURIComponent(text)}`, "QR");
  }, [lookup]);

  const scanNext = () => {
    setSheet(null);
    setScanning(true);
  };

  const submit = async (reservation: CheckinReservation, count: number | null, method: CheckinMethod, editing: boolean) => {
    const response = await fetch("/api/admin/checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reservationId: reservation.reservationId,
        count,
        method,
        expectedSessionId: session.sessionId,
        allowUpdate: editing,
      }),
    });
    const payload = await response.json().catch(() => ({})) as ApiError & { reservation?: CheckinReservation };
    if (response.ok && payload.reservation) {
      setSheet({ kind: "success", reservation: payload.reservation, method, undone: count === null });
      router.refresh();
      return;
    }
    if (payload.code === "ALREADY_DONE" || payload.code === "WRONG_SESSION") {
      // Outro instrutor pode ter registrado no meio tempo: mostra o estado real.
      await lookup(`reservationId=${reservation.reservationId}`, method);
      router.refresh();
      return;
    }
    throw new Error(payload.message ?? "Não foi possível registrar o check-in.");
  };

  const openRow = (row: AttendanceReservation) => present(asCheckinReservation(row), "MANUAL");

  return (
    <div className="pb-32">
      <Link href={`${basePath}?data=${session.startsAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(session.startsAt)) : ""}`} className="inline-flex h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink hover:bg-ink/5">
        <ArrowLeft className="size-4" /> Turmas do dia
      </Link>

      <header className="mt-3 rounded-3xl bg-ink p-5 text-white sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sand">Lista de Presença</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{session.experienceTitle}</h1>
        <p className="mt-1 text-base text-white/75">
          {formatSessionDateShort(session.startsAt)} • <span className="font-semibold text-white">{formatSessionTime(session.startsAt)}</span>
          {session.baseName ? ` • ${session.baseName}` : ""}
        </p>
        <p className="mt-5 text-4xl font-semibold tracking-tight" aria-live="polite">
          {totals.present} <span className="text-2xl text-white/60">/ {totals.reservedSpots} presentes</span>
        </p>
        <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/15" aria-hidden>
          <div className="h-full rounded-full bg-emerald-400" style={{ width: `${totals.reservedSpots ? Math.min(100, (totals.present / totals.reservedSpots) * 100) : 0}%` }} />
        </div>
        <p className="mt-3 text-sm text-white/70">
          {totals.reservations} {totals.reservations === 1 ? "reserva" : "reservas"} • {totals.pendingSpots} {totals.pendingSpots === 1 ? "vaga aguardando" : "vagas aguardando"}
        </p>
      </header>

      {session.reservations.length === 0 ? (
        <p className="mt-6 rounded-3xl border border-dashed border-ink/15 bg-white p-6 text-center text-base text-ink/60">Nenhuma reserva confirmada nesta turma.</p>
      ) : (
        <ul className="mt-5 space-y-3" aria-label="Reservas da turma">
          {session.reservations.map((row) => {
            const state = presenceState(row.quantity, row.checkedInCount);
            const style = STATE_STYLES[state];
            return (
              <li key={row.reservationId}>
                <button
                  type="button"
                  onClick={() => openRow(row)}
                  className={cn("flex w-full items-center gap-4 rounded-3xl border p-4 text-left transition active:scale-[0.99]", style.row)}
                >
                  <span className="text-2xl leading-none" aria-hidden>{style.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-semibold text-ink">{row.fullName}</span>
                    <span className="mt-0.5 block text-base text-ink/70">
                      {vagas(row.quantity)} • {presentes(row.checkedInCount ?? 0)}
                      {row.checkedInAt ? ` • ${timeOf(row.checkedInAt)}` : ""}
                    </span>
                    <span className={cn("mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold", style.badge)}>{PRESENCE_LABELS[state]}</span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-ink/35" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink/10 bg-white/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-72">
        <button
          type="button"
          onClick={() => setScanning(true)}
          className="mx-auto flex h-16 w-full max-w-xl items-center justify-center gap-3 rounded-full bg-lake text-lg font-semibold text-white shadow-lg transition active:scale-[0.98]"
        >
          <ScanLine className="size-6" /> Escanear QR Code
        </button>
      </div>

      {scanning ? <QrScanner onResult={onScan} onClose={() => setScanning(false)} /> : null}
      {sheet ? (
        <CheckinSheet
          sheet={sheet}
          onClose={() => setSheet(null)}
          onScanNext={scanNext}
          onEdit={(reservation, method) => setSheet({ kind: "form", reservation, method, editing: true })}
          onSubmit={submit}
        />
      ) : null}
    </div>
  );
}

function CheckinSheet({ sheet, onClose, onScanNext, onEdit, onSubmit }: {
  sheet: Sheet;
  onClose: () => void;
  onScanNext: () => void;
  onEdit: (reservation: CheckinReservation, method: CheckinMethod) => void;
  onSubmit: (reservation: CheckinReservation, count: number | null, method: CheckinMethod, editing: boolean) => Promise<void>;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/55 backdrop-blur-sm sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && sheet.kind !== "loading") onClose();
    }}>
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[2rem] bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-soft sm:rounded-[2rem]" role="dialog" aria-modal="true" aria-label="Check-in">
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="grid size-11 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>
        <SheetBody sheet={sheet} onClose={onClose} onScanNext={onScanNext} onEdit={onEdit} onSubmit={onSubmit} />
      </div>
    </div>
  );
}

function ReservationSummary({ reservation }: { reservation: CheckinReservation }) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{reservation.fullName}</h2>
      <p className="mt-1 text-base text-ink/70">{reservation.experienceTitle}</p>
      <p className="text-base text-ink/70">{formatSessionDateShort(reservation.startsAt)} • {formatSessionTime(reservation.startsAt)}</p>
      <p className="mt-2 text-base font-semibold text-ink">{reservation.quantity} {reservation.quantity === 1 ? "vaga reservada" : "vagas reservadas"}</p>
    </div>
  );
}

const primary = "flex h-14 w-full items-center justify-center gap-2 rounded-full bg-ink text-lg font-semibold text-white transition active:scale-[0.98] disabled:opacity-50";
const secondary = "flex h-14 w-full items-center justify-center gap-2 rounded-full bg-white text-lg font-semibold text-ink ring-1 ring-ink/15 transition active:scale-[0.98] disabled:opacity-50";

function SheetBody({ sheet, onClose, onScanNext, onEdit, onSubmit }: Parameters<typeof CheckinSheet>[0]) {
  const basePath = useContext(BasePathContext);
  if (sheet.kind === "loading") {
    return <p className="py-10 text-center text-lg text-ink/70" aria-live="polite">Identificando reserva…</p>;
  }

  if (sheet.kind === "error") {
    return (
      <div className="text-center">
        <AlertTriangle className="mx-auto size-12 text-red-700" />
        <h2 className="mt-4 text-2xl font-semibold text-ink">QR Code não reconhecido</h2>
        <p className="mt-2 text-base leading-6 text-ink/70" role="alert">{sheet.message}</p>
        <div className="mt-6 space-y-3">
          <button type="button" className={primary} onClick={onScanNext}><ScanLine className="size-5" /> Tentar de novo</button>
          <button type="button" className={secondary} onClick={onClose}>Voltar à lista</button>
        </div>
      </div>
    );
  }

  if (sheet.kind === "notConfirmed") {
    return (
      <div>
        <div className="rounded-2xl bg-red-50 p-4 text-base font-semibold text-red-900" role="alert">Esta reserva não está confirmada. Check-in não permitido.</div>
        <div className="mt-5"><ReservationSummary reservation={sheet.reservation} /></div>
        <div className="mt-6 space-y-3">
          <button type="button" className={primary} onClick={onScanNext}><ScanLine className="size-5" /> Escanear próximo</button>
          <button type="button" className={secondary} onClick={onClose}>Voltar à lista</button>
        </div>
      </div>
    );
  }

  if (sheet.kind === "wrongSession") {
    return (
      <div>
        <div className="flex items-start gap-3 rounded-2xl bg-amber-100 p-4 text-amber-950" role="alert">
          <AlertTriangle className="mt-0.5 size-6 shrink-0" />
          <p className="text-lg font-semibold">Este QR pertence a outra experiência.</p>
        </div>
        <div className="mt-5 rounded-2xl bg-mist/70 p-4">
          <p className="text-xl font-semibold text-ink">{sheet.reservation.experienceTitle}</p>
          <p className="mt-1 text-base text-ink/70">{formatSessionDateShort(sheet.reservation.startsAt)} • {formatSessionTime(sheet.reservation.startsAt)}</p>
          <p className="mt-1 text-base text-ink/70">{sheet.reservation.fullName} • {vagas(sheet.reservation.quantity)}</p>
        </div>
        <p className="mt-3 text-sm text-ink/60">Nenhuma presença foi registrada.</p>
        <div className="mt-6 space-y-3">
          <Link href={`${basePath}/${sheet.reservation.sessionId}`} className={primary} onClick={onClose}>Abrir experiência correta</Link>
          <button type="button" className={secondary} onClick={onScanNext}><ScanLine className="size-5" /> Escanear próximo</button>
        </div>
      </div>
    );
  }

  if (sheet.kind === "already") {
    const count = sheet.reservation.checkedInCount ?? 0;
    return (
      <div>
        <div className="flex items-center gap-3 rounded-2xl bg-sky-50 p-4 text-sky-950" role="status">
          <CheckCircle2 className="size-6 shrink-0" />
          <p className="text-lg font-semibold">Check-in já realizado</p>
        </div>
        <div className="mt-5"><ReservationSummary reservation={sheet.reservation} /></div>
        <p className="mt-4 text-3xl font-semibold text-ink">{count} <span className="text-xl text-ink/60">de {sheet.reservation.quantity} presentes</span></p>
        <p className="mt-1 text-sm text-ink/60">
          Check-in: {timeOf(sheet.reservation.checkedInAt)}
          {sheet.reservation.checkinMethod ? ` • ${sheet.reservation.checkinMethod === "QR" ? "QR Code" : "manual"}` : ""}
          {sheet.reservation.checkedInByName ? ` • ${sheet.reservation.checkedInByName}` : ""}
        </p>
        <div className="mt-6 space-y-3">
          <button type="button" className={primary} onClick={onScanNext}><ScanLine className="size-5" /> Escanear próximo</button>
          <button type="button" className={secondary} onClick={() => onEdit(sheet.reservation, sheet.reservation.checkinMethod ?? sheet.method)}>Editar check-in</button>
        </div>
      </div>
    );
  }

  if (sheet.kind === "success") {
    const count = sheet.reservation.checkedInCount ?? 0;
    return (
      <div className="text-center">
        <CheckCircle2 className={cn("mx-auto size-16", sheet.undone ? "text-ink/40" : "text-emerald-600")} />
        <h2 className="mt-4 text-2xl font-semibold text-ink" role="status">{sheet.undone ? "Check-in desfeito" : "Check-in realizado com sucesso"}</h2>
        <p className="mt-3 text-xl font-semibold text-ink">{sheet.reservation.fullName}</p>
        {sheet.undone ? (
          <p className="mt-1 text-lg text-ink/70">A reserva voltou para “aguardando”.</p>
        ) : (
          <p className="mt-1 text-lg text-ink/70">{count} de {sheet.reservation.quantity} presentes</p>
        )}
        <div className="mt-6 space-y-3">
          <button type="button" className={primary} onClick={onScanNext}><ScanLine className="size-5" /> Escanear próximo</button>
          <button type="button" className={secondary} onClick={onClose}>Voltar à lista</button>
        </div>
      </div>
    );
  }

  return <CheckinForm key={`${sheet.reservation.reservationId}-${sheet.editing}`} sheet={sheet} onSubmit={onSubmit} onClose={onClose} />;
}

function CheckinForm({ sheet, onSubmit, onClose }: {
  sheet: Extract<Sheet, { kind: "form" }>;
  onSubmit: (reservation: CheckinReservation, count: number | null, method: CheckinMethod, editing: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { reservation, method, editing } = sheet;
  const [count, setCount] = useState(editing ? reservation.checkedInCount ?? reservation.quantity : reservation.quantity);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);

  const send = async (value: number | null) => {
    setLoading(true);
    setError("");
    try {
      await onSubmit(reservation, value, method, editing);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível registrar.");
      setLoading(false);
    }
  };

  return (
    <div>
      {editing ? <p className="mb-3 inline-flex rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900">Corrigindo check-in</p> : null}
      {method === "MANUAL" && !editing ? <p className="mb-3 inline-flex items-center gap-1 rounded-full bg-mist px-3 py-1 text-sm font-semibold text-ink"><UserCheck className="size-4" /> Check-in manual</p> : null}
      <ReservationSummary reservation={reservation} />

      <p className="mt-6 text-center text-lg font-semibold text-ink">Quantos compareceram?</p>
      <div className="mt-3 flex items-center justify-center gap-5">
        <button type="button" onClick={() => setCount((value) => Math.max(0, value - 1))} disabled={loading || count <= 0} className="grid size-16 place-items-center rounded-full bg-mist text-ink transition active:scale-95 disabled:opacity-40" aria-label="Menos uma pessoa">
          <Minus className="size-7" />
        </button>
        <output className="w-20 text-center text-5xl font-semibold tabular-nums text-ink" aria-live="polite">{count}</output>
        <button type="button" onClick={() => setCount((value) => Math.min(reservation.quantity, value + 1))} disabled={loading || count >= reservation.quantity} className="grid size-16 place-items-center rounded-full bg-mist text-ink transition active:scale-95 disabled:opacity-40" aria-label="Mais uma pessoa">
          <Plus className="size-7" />
        </button>
      </div>
      <p className="mt-2 text-center text-sm text-ink/60">
        {count === reservation.quantity ? "Presença completa" : count === 0 ? "Registrar ausência" : `Presença parcial (${count} de ${reservation.quantity})`}
      </p>

      {error ? <p className="mt-4 rounded-2xl bg-red-50 p-3 text-center text-base text-red-900" role="alert">{error}</p> : null}

      <div className="mt-6 space-y-3">
        <button type="button" className={cn(primary, "bg-emerald-700")} disabled={loading} onClick={() => send(count)}>
          <CheckCircle2 className="size-5" /> {loading ? "Registrando…" : editing ? "Salvar correção" : count === 0 ? "Registrar ausência" : "Confirmar check-in"}
        </button>
        {editing ? (
          <button
            type="button"
            className={cn(secondary, confirmUndo && "bg-red-50 text-red-800 ring-red-200")}
            disabled={loading}
            onClick={() => (confirmUndo ? send(null) : setConfirmUndo(true))}
          >
            <RotateCcw className="size-5" /> {confirmUndo ? "Toque de novo para desfazer" : "Desfazer check-in"}
          </button>
        ) : null}
        <button type="button" className={secondary} disabled={loading} onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}
