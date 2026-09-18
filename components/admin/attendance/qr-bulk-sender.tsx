"use client";

import Link from "next/link";
import { useState } from "react";
import { Mail, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type Preview = { reservations: number; participants: number };
type Chunk = {
  processed: number;
  sent: number;
  skipped: Record<string, number>;
  failed: Array<{ reservationId: string; errorCode: string }>;
  failedCodes: Record<string, string>;
  remaining: number;
  message?: string;
};
type Totals = { initial: number; sent: number; skipped: number; processed: number; failed: Array<{ reservationId: string; publicCode: string; errorCode: string }> };

const MAX_ROUNDS = 30;

const ERROR_LABELS: Record<string, string> = {
  SENT_NOT_RECORDED: "e-mail enviado, mas o registro falhou — não reenviar",
  PAYLOAD_EMPTY: "dados da reserva incompletos",
  HTTP_429: "limite do provedor de e-mail",
  TIMEOUT: "tempo esgotado",
};

/**
 * "Enviar QRs pendentes": resumo → confirmação → envio em pedaços → relatório.
 * Não mostra e-mail nem nome; falhas aparecem pelo código da reserva.
 */
export function QrBulkSender() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<Totals | null>(null);

  const start = async () => {
    setOpen(true);
    setPreview(null);
    setTotals(null);
    setError("");
    try {
      const response = await fetch("/api/admin/checkin/qr-bulk", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as Preview & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Não foi possível calcular os QRs pendentes.");
      setPreview(payload);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível calcular os QRs pendentes.");
    }
  };

  const send = async () => {
    if (!preview) return;
    setRunning(true);
    setError("");
    const acc: Totals = { initial: preview.reservations, sent: 0, skipped: 0, processed: 0, failed: [] };
    setTotals({ ...acc });
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const response = await fetch("/api/admin/checkin/qr-bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ exclude: acc.failed.map((item) => item.reservationId) }),
        });
        const chunk = await response.json().catch(() => ({})) as Chunk;
        if (!response.ok) throw new Error(chunk.message ?? "O envio foi interrompido.");
        acc.sent += chunk.sent;
        acc.processed += chunk.processed;
        acc.skipped += Object.values(chunk.skipped ?? {}).reduce((sum, value) => sum + value, 0);
        acc.failed.push(...chunk.failed.map((item) => ({ ...item, publicCode: chunk.failedCodes[item.reservationId] ?? "" })));
        setTotals({ ...acc, failed: [...acc.failed] });
        // Para quando não há mais pendentes ou quando nada pôde ser processado
        // (ex.: outro administrador está enviando as mesmas reservas agora).
        if (chunk.remaining === 0 || chunk.processed === 0) break;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "O envio foi interrompido.");
    } finally {
      setRunning(false);
    }
  };

  const finished = totals && !running;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={start}>
        <Mail className="size-4" /> Enviar QRs pendentes
      </Button>
      {open ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/55 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !running) setOpen(false);
        }}>
          <div className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-soft sm:p-8" role="dialog" aria-modal="true" aria-labelledby="qr-bulk-title">
            <div className="flex items-start justify-between gap-4">
              <div className="grid size-11 place-items-center rounded-2xl bg-mist text-forest"><Send className="size-5" /></div>
              <button type="button" onClick={() => setOpen(false)} disabled={running} className="grid size-9 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar">
                <X className="size-5" />
              </button>
            </div>

            {!totals ? (
              <>
                <h2 id="qr-bulk-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">
                  {preview ? (preview.reservations ? `Enviar QR Code por e-mail para ${preview.reservations} ${preview.reservations === 1 ? "reserva futura" : "reservas futuras"}?` : "Nenhum QR pendente") : "Calculando QRs pendentes…"}
                </h2>
                {preview && preview.reservations ? (
                  <>
                    <p className="mt-3 text-lg font-semibold text-forest">{preview.reservations} {preview.reservations === 1 ? "reserva" : "reservas"} · {preview.participants} participantes</p>
                    <p className="mt-3 text-sm leading-6 text-ink/60">Cada cliente recebe o lembrete com o próprio QR Code, igual ao “Reenviar QR Code”. Quem já recebeu o QR não recebe de novo. A lista é recalculada no momento do envio.</p>
                  </>
                ) : preview ? (
                  <p className="mt-3 text-sm leading-6 text-ink/60">Todas as reservas futuras confirmadas já receberam o QR Code.</p>
                ) : null}
                {error ? <p className="mt-4 rounded-2xl bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p> : null}
                <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
                  {preview && preview.reservations ? <Button type="button" onClick={send}><Send className="size-4" /> Enviar QRs</Button> : null}
                </div>
              </>
            ) : (
              <>
                <h2 id="qr-bulk-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink" aria-live="polite">
                  {running ? "Enviando QRs…" : "Envio concluído"}
                </h2>
                <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-2xl bg-mist/60 p-3"><dt className="text-ink/55">Elegíveis inicialmente</dt><dd className="mt-0.5 text-xl font-semibold">{totals.initial}</dd></div>
                  <div className="rounded-2xl bg-emerald-50 p-3"><dt className="text-emerald-800/70">Enviados</dt><dd className="mt-0.5 text-xl font-semibold text-emerald-800">{totals.sent}</dd></div>
                  <div className="rounded-2xl bg-slate-100 p-3"><dt className="text-slate-700/70">Ignorados</dt><dd className="mt-0.5 text-xl font-semibold text-slate-800">{totals.skipped}</dd></div>
                  <div className="rounded-2xl bg-red-50 p-3"><dt className="text-red-800/70">Falhas</dt><dd className="mt-0.5 text-xl font-semibold text-red-800">{totals.failed.length}</dd></div>
                </dl>
                <p className="mt-3 text-sm text-ink/60">Total processado: {totals.processed}</p>
                {totals.failed.length ? (
                  <div className="mt-4 rounded-2xl border border-red-200 p-4">
                    <p className="text-sm font-semibold text-red-900">Reservas com falha</p>
                    <ul className="mt-2 space-y-1 text-sm">
                      {totals.failed.map((item) => (
                        <li key={item.reservationId}>
                          <Link href={`/admin/reservas/${item.reservationId}`} className="font-mono text-lake hover:underline">{item.publicCode || "Abrir reserva"}</Link>
                          <span className="text-ink/60"> · {ERROR_LABELS[item.errorCode] ?? item.errorCode}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-ink/55">Reservas com falha continuam pendentes: rode “Enviar QRs pendentes” de novo ou use “Reenviar QR Code” na reserva.</p>
                  </div>
                ) : null}
                {error ? <p className="mt-4 rounded-2xl bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p> : null}
                {finished ? (
                  <div className="mt-7 flex justify-end"><Button type="button" onClick={() => setOpen(false)}>Fechar</Button></div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
