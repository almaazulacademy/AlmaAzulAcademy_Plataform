import Link from "next/link";
import { BellRing } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { JOIN_WAITLIST_LABEL, waitlistSignupHref } from "@/lib/waitlist/public";

/**
 * "Entrar na lista de espera": leva à página de inscrição da turma. Só aparece
 * com a inscrição ligada; quem decide se a turma aceita inscrição é o banco.
 */
export function WaitlistJoinLink({ sessionId, tone = "light", ariaLabel, className }: { sessionId: string; tone?: "light" | "dark"; ariaLabel?: string; className?: string }) {
  return (
    <Link
      href={waitlistSignupHref(sessionId)}
      aria-label={ariaLabel ?? JOIN_WAITLIST_LABEL}
      className={cn(buttonVariants({ variant: tone === "dark" ? "light" : "outline", size: "sm" }), "w-full sm:w-auto", className)}
    >
      <BellRing aria-hidden="true" className="size-4" />
      {JOIN_WAITLIST_LABEL}
    </Link>
  );
}
