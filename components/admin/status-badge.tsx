import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  OPEN: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  PUBLISHED: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  CONFIRMED: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  PAID: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  PRE_RESERVED: "bg-amber-50 text-amber-800 ring-amber-600/15",
  PENDING: "bg-amber-50 text-amber-800 ring-amber-600/15",
  CLOSED: "bg-slate-100 text-slate-700 ring-slate-500/15",
  DRAFT: "bg-slate-100 text-slate-700 ring-slate-500/15",
  NOT_PAID: "bg-slate-100 text-slate-700 ring-slate-500/15",
  CANCELLED: "bg-red-50 text-red-800 ring-red-600/15",
  ARCHIVED: "bg-red-50 text-red-800 ring-red-600/15",
  EXPIRED: "bg-red-50 text-red-800 ring-red-600/15",
  PAID_AFTER_EXPIRATION: "bg-purple-50 text-purple-800 ring-purple-600/15",
};

const labels: Record<string, string> = {
  OPEN: "Aberta",
  CLOSED: "Fechada",
  CANCELLED: "Cancelada",
  DRAFT: "Rascunho",
  PUBLISHED: "Ativa",
  ARCHIVED: "Arquivada",
  PRE_RESERVED: "Pré-reserva",
  CONFIRMED: "Confirmada",
  EXPIRED: "Expirada",
  PENDING: "Pendente",
  PAID: "Pago",
  NOT_PAID: "Não pago",
  PAID_AFTER_EXPIRATION: "Pago após expirar",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", styles[status] ?? styles.CLOSED, className)}>
      {labels[status] ?? status}
    </span>
  );
}
