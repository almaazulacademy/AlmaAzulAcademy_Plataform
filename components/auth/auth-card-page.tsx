import Image from "next/image";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { ToastProvider } from "@/components/admin/toast-provider";

/** Moldura das telas de conta da equipe (esqueci / redefinir senha). */
export function AuthCardPage({ icon: Icon, eyebrow, title, description, children }: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      <main className="flex min-h-screen items-center justify-center bg-paper p-6 sm:p-12">
        <div className="w-full max-w-md">
          <Image src="/images/branding/alma-azul-logo-dark.png" alt="Alma Azul" width={185} height={100} className="h-auto w-36" priority />
          <div className="mt-12 grid size-12 place-items-center rounded-2xl bg-forest text-white"><Icon className="size-5" /></div>
          <p className="mt-7 text-xs font-semibold uppercase tracking-[0.2em] text-lake">{eyebrow}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em]">{title}</h1>
          <p className="mt-4 max-w-sm leading-7 text-ink/60">{description}</p>
          {children}
        </div>
      </main>
    </ToastProvider>
  );
}
