import { CalendarDays, Clock3, Ticket, Users } from "lucide-react";

import { getSupabaseServerClient } from "@/lib/supabase/server";

type UnknownRow = Record<string, unknown>;

function numberFrom(row: UnknownRow, keys: string[], fallback = 0) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function dateFrom(row: UnknownRow) {
  const value = row.starts_at ?? row.start_at ?? row.date ?? row.session_date;
  return typeof value === "string" ? new Date(value) : null;
}

function remainingSeats(row: UnknownRow) {
  const explicit = numberFrom(row, ["remaining_spots", "available_spots", "spots_remaining"], Number.NaN);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);

  const capacity = numberFrom(row, ["capacity", "max_capacity", "total_spots"]);
  const reservations = Array.isArray(row.reservations) ? (row.reservations as UnknownRow[]) : [];
  const reserved = reservations
    .filter((item) => !["cancelled", "canceled"].includes(String(item.status ?? "").toLowerCase()))
    .reduce((sum, item) => sum + numberFrom(item, ["quantity", "spots", "guests", "party_size"], 1), 0);
  const storedReserved = numberFrom(row, ["reserved_spots", "booked_spots", "bookings_count"], reserved);
  return Math.max(0, capacity - storedReserved);
}

function priceFrom(row: UnknownRow) {
  const cents = numberFrom(row, ["price_cents", "price_in_cents"], Number.NaN);
  return Number.isFinite(cents) ? cents / 100 : numberFrom(row, ["price", "amount"]);
}

export function SessionsLoading() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-label="Carregando próximas datas" aria-busy="true">
      {[0, 1, 2].map((item) => <div key={item} className="h-72 animate-pulse rounded-3xl bg-white/10" />)}
    </div>
  );
}

function EmptyState({ error = false }: { error?: boolean }) {
  return (
    <div className="rounded-4xl border border-white/15 bg-white/[0.06] px-6 py-14 text-center sm:px-12">
      <CalendarDays className="mx-auto size-7 text-sand" />
      <h3 className="mt-5 text-2xl font-medium">{error ? "Não foi possível carregar as datas agora." : "Novas datas serão abertas em breve."}</h3>
      <p className="mx-auto mt-3 max-w-lg leading-7 text-white/60">
        {error ? "Tente novamente em alguns instantes. A experiência continua por aqui." : "Estamos preparando as próximas sessões da Imersão Paranoá. Volte em breve para encontrar sua data."}
      </p>
    </div>
  );
}

export async function SessionsSection() {
  const supabase = getSupabaseServerClient();
  if (!supabase) return <EmptyState />;

  const now = new Date().toISOString();
  const query = await supabase
    .from("sessions")
    .select("*")
    .gte("starts_at", now)
    .eq("status", "open")
    .order("starts_at", { ascending: true });

  if (query.error) {
    console.error("Erro ao ler sessões abertas:", query.error.message);
    return <EmptyState error />;
  }

  const rows = query.data ?? [];
  const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  let reservations: UnknownRow[] = [];

  if (ids.length) {
    const reservationResult = await supabase.from("reservations").select("*").in("session_id", ids);
    if (!reservationResult.error) {
      reservations = reservationResult.data;
    } else {
      const bookingResult = await supabase.from("bookings").select("*").in("session_id", ids);
      if (!bookingResult.error) reservations = bookingResult.data;
    }
  }

  const enrichedRows = rows.map((row) => ({
    ...row,
    reservations: reservations.filter((reservation) => reservation.session_id === row.id),
  }));

  const sessions = enrichedRows.filter((row) => {
    const date = dateFrom(row);
    return date && date.getTime() > Date.now() && remainingSeats(row) > 0;
  });
  if (!sessions.length) return <EmptyState />;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {sessions.map((session, index) => {
        const date = dateFrom(session)!;
        const remaining = remainingSeats(session);
        return (
          <article key={String(session.id ?? index)} className="group rounded-3xl border border-white/15 bg-white/[0.07] p-7 transition duration-300 hover:-translate-y-1 hover:bg-white/[0.11]">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sand">{new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(date)}</p>
                <p className="mt-2 text-3xl font-medium capitalize">{new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long" }).format(date)}</p>
              </div>
              <CalendarDays className="size-5 text-white/45" />
            </div>
            <div className="mt-10 space-y-3 border-t border-white/10 pt-6 text-sm text-white/70">
              <p className="flex items-center gap-3"><Clock3 className="size-4 text-sand" />{new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date)}</p>
              <p className="flex items-center gap-3"><Ticket className="size-4 text-sand" />{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(priceFrom(session))}</p>
              <p className="flex items-center gap-3"><Users className="size-4 text-sand" />{remaining} {remaining === 1 ? "vaga restante" : "vagas restantes"}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
