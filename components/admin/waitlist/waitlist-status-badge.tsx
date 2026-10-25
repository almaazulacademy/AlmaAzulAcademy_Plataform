import { cn } from "@/lib/utils";
import { WAITLIST_STATUS_LABELS, type WaitlistEntryStatus } from "@/lib/admin/waitlist";

const styles: Record<WaitlistEntryStatus, string> = {
  ACTIVE: "bg-lake/10 text-lake ring-lake/20",
  CONVERTED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  CANCELLED: "bg-ink/5 text-ink/60 ring-ink/10",
  REMOVED: "bg-red-50 text-red-700 ring-red-200",
  EXPIRED: "bg-ink/5 text-ink/50 ring-ink/10",
};

export function WaitlistStatusBadge({ status, className }: { status: WaitlistEntryStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", styles[status], className)}>
      {WAITLIST_STATUS_LABELS[status]}
    </span>
  );
}
