"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LogOut } from "lucide-react";

import { ToastProvider, useToast } from "@/components/admin/toast-provider";
import type { StaffProfile } from "@/lib/admin/types";

/**
 * Moldura da área do instrutor: só a marca, quem está logado e "Sair".
 * Nenhum item do painel administrativo existe aqui, nem escondido.
 */
function InstructorShellContent({ children, profile }: { children: ReactNode; profile: Pick<StaffProfile, "displayName" | "email"> }) {
  const router = useRouter();
  const { notify } = useToast();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Não foi possível encerrar a sessão.");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      notify({ title: "Falha ao sair", description: error instanceof Error ? error.message : "Tente novamente.", variant: "error" });
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f3f5f1]">
      <header className="sticky top-0 z-40 border-b border-ink/10 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/instrutor" aria-label="Lista de Presença" className="shrink-0">
            <Image src="/images/branding/alma-azul-logo-dark.png" alt="Alma Azul" width={120} height={65} className="h-auto w-24" priority />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-sm font-semibold text-ink">{profile.displayName}</p>
              <p className="truncate text-xs text-ink/50">{profile.email}</p>
            </div>
            <button
              type="button"
              onClick={logout}
              disabled={loggingOut}
              className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold text-ink ring-1 ring-ink/15 transition hover:bg-mist disabled:opacity-50"
            >
              <LogOut className="size-4" /> {loggingOut ? "Saindo..." : "Sair"}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}

export function InstructorShell({ children, profile }: { children: ReactNode; profile: Pick<StaffProfile, "displayName" | "email"> }) {
  return <ToastProvider><InstructorShellContent profile={profile}>{children}</InstructorShellContent></ToastProvider>;
}
