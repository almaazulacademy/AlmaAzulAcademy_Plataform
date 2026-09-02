"use client";

import { CalendarDays, CalendarX2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DATE_FILTER_PARAM,
  formatDayKeyLabel,
  isValidDayKey,
  parseDateFilter,
} from "@/lib/sessions/date-filter";

/**
 * Um bloco filtrável da listagem.
 *
 * O `node` já vem renderizado pelo servidor — um cartão da agenda geral, um dia
 * inteiro de turmas na página da experiência. Este componente não sabe o que
 * tem dentro e não monta cartão nenhum: ele só decide quais blocos continuam na
 * tela. É o que permite a mesma peça servir às duas listagens sem duplicar
 * marcação e sem mandar os dados das sessões para o navegador.
 */
export type SessionDateFilterEntry = {
  /** Chave de lista. O `sessions.id` na agenda, o dia na grade da experiência. */
  key: string;
  /** `2026-10-17`, o dia local em America/Sao_Paulo. */
  dayKey: string;
  /** Quantas turmas o bloco representa. Um cartão vale 1; um dia vale as suas. */
  count?: number;
  node: ReactNode;
};

type Tone = "light" | "dark";

type Props = {
  entries: SessionDateFilterEntry[];
  /** Classes da grade original, para o filtro não mexer no layout de quem chama. */
  listClassName: string;
  tone: Tone;
  /** Data validada lida na URL pelo servidor. Garante o mesmo HTML no primeiro render. */
  initialDate: string | null;
  /** Frase do estado vazio, específica do contexto. */
  emptyMessage: string;
};

const TONES = {
  light: {
    panel: "border-ink/10 bg-white shadow-soft",
    label: "text-ink/45",
    input: "border-ink/15 bg-paper text-ink focus:border-lake",
    status: "text-ink/55",
    clear: buttonVariants({ variant: "outline", size: "sm" }),
    empty: "border-ink/10 bg-white shadow-soft",
    emptyTitle: "text-forest",
    emptyText: "text-ink/65",
    emptyAction: buttonVariants({ size: "sm" }),
    icon: "text-lake",
  },
  dark: {
    panel: "border-white/15 bg-white/[0.06]",
    label: "text-white/50",
    input: "border-white/20 bg-white/[0.08] text-white focus:border-sand [color-scheme:dark]",
    status: "text-white/60",
    clear: buttonVariants({ variant: "light", size: "sm" }),
    empty: "border-white/15 bg-white/[0.06]",
    emptyTitle: "text-white",
    emptyText: "text-white/60",
    emptyAction: buttonVariants({ variant: "light", size: "sm" }),
    icon: "text-sand",
  },
} as const satisfies Record<Tone, Record<string, string>>;

/** Reescreve `?date=` sem recarregar a página nem refazer a consulta do servidor. */
function pushDateToUrl(date: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (date) url.searchParams.set(DATE_FILTER_PARAM, date);
  else url.searchParams.delete(DATE_FILTER_PARAM);
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function turmaCount(entries: SessionDateFilterEntry[]) {
  return entries.reduce((total, entry) => total + (entry.count ?? 1), 0);
}

/**
 * Filtro de data das listagens públicas de sessões.
 *
 * O recorte é feito **no navegador**, sobre os blocos que o servidor já mandou:
 * a agenda inteira cabe em uma resposta, então uma consulta nova por clique
 * seria trabalho de backend sem ganho para o cliente. Trocar de data é imediato
 * e não repinta a página.
 *
 * A data escolhida vai para a URL (`?date=2026-10-17`) pela History API nativa,
 * o que mantém link compartilhável, refresh e voltar/avançar previsíveis sem
 * disparar um novo render do servidor. O estado inicial vem do servidor já
 * validado, então o primeiro HTML — inclusive o de um link compartilhado — já
 * nasce filtrado.
 */
export function SessionDateFilter({ entries, listClassName, tone, initialDate, emptyMessage }: Props) {
  // A data volta a passar pela validação aqui de propósito: o componente é
  // público e não pode depender de quem o chama ter feito a checagem. Um valor
  // torto vira "sem filtro" em vez de virar rótulo vazio na tela.
  const [date, setDate] = useState<string | null>(() => parseDateFilter(initialDate ?? undefined));
  const styles = TONES[tone];

  // Voltar/avançar do navegador: a URL é a fonte da verdade, então o estado
  // acompanha o histórico em vez de ficar preso à escolha anterior.
  useEffect(() => {
    const syncFromUrl = () => {
      setDate(parseDateFilter(new URLSearchParams(window.location.search).get(DATE_FILTER_PARAM) ?? undefined));
    };
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  const days = useMemo(() => {
    const unique = new Set(entries.map((entry) => entry.dayKey).filter(Boolean));
    return [...unique].sort();
  }, [entries]);

  const visible = useMemo(
    () => (date ? entries.filter((entry) => entry.dayKey === date) : entries),
    [entries, date],
  );

  const apply = useCallback((value: string | null) => {
    const next = value && isValidDayKey(value) ? value : null;
    setDate(next);
    pushDateToUrl(next);
  }, []);

  const clear = useCallback(() => apply(null), [apply]);

  const total = turmaCount(visible);
  const status = date
    ? `${total} ${total === 1 ? "turma" : "turmas"} em ${formatDayKeyLabel(date)}`
    : `Mostrando todas as próximas datas — ${turmaCount(entries)} ${turmaCount(entries) === 1 ? "turma" : "turmas"}`;

  return (
    <div>
      <div className={cn("rounded-3xl border p-4 sm:p-5", styles.panel)}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <label className="w-full sm:max-w-[16rem]">
            <span className={cn("flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em]", styles.label)}>
              <CalendarDays aria-hidden="true" className={cn("size-4", styles.icon)} />
              Escolha uma data
            </span>
            <input
              type="date"
              name={DATE_FILTER_PARAM}
              value={date ?? ""}
              min={days[0]}
              max={days[days.length - 1]}
              onChange={(event) => apply(event.target.value)}
              className={cn(
                "mt-2.5 h-12 w-full rounded-2xl border px-4 text-base outline-none transition-colors",
                styles.input,
              )}
            />
          </label>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
            {/* A contagem é sempre anunciada, mas some da tela quando dá zero:
                o estado vazio logo abaixo já diz a mesma coisa com mais cuidado,
                e repetir "0 turmas" aqui só somaria ruído visual. */}
            <p
              aria-live="polite"
              className={cn(
                visible.length ? cn("text-sm leading-6 first-letter:uppercase", styles.status) : "sr-only",
              )}
            >
              {status}
            </p>
            {date ? (
              <button type="button" onClick={clear} className={cn(styles.clear, "w-full shrink-0 sm:w-auto")}>
                <X aria-hidden="true" className="size-4" />
                Ver todas as datas
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-8 sm:mt-10">
        {visible.length ? (
          <div className={listClassName}>
            {/* Fragment com key: o bloco entra na grade exatamente como o
                servidor o desenhou, sem um wrapper que quebre `grid` ou
                `space-y`. */}
            {visible.map((entry) => (
              <Fragment key={entry.key}>{entry.node}</Fragment>
            ))}
          </div>
        ) : (
          <div className={cn("rounded-4xl border px-6 py-14 text-center sm:px-12", styles.empty)}>
            <CalendarX2 aria-hidden="true" className={cn("mx-auto size-7", styles.icon)} />
            <h3 className={cn("mt-5 text-2xl font-medium tracking-[-0.03em] sm:text-3xl", styles.emptyTitle)}>
              {emptyMessage}
            </h3>
            {date ? (
              <p className={cn("mx-auto mt-4 max-w-lg leading-7", styles.emptyText)}>
                Nada acontece em {formatDayKeyLabel(date)}. Veja as outras datas abertas.
              </p>
            ) : null}
            <button type="button" onClick={clear} className={cn(styles.emptyAction, "mt-7")}>
              <CalendarDays aria-hidden="true" className="size-4" />
              Ver todas as datas
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
