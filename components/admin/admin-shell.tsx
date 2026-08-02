"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  BookOpenCheck,
  CalendarDays,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Waves,
  X,
} from "lucide-react";

import { ToastProvider, useToast } from "@/components/admin/toast-provider";
import { cn } from "@/lib/utils";
import type { AdminProfile } from "@/lib/admin/types";

const navigation = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/sessoes", label: "Sessões", icon: CalendarDays },
  { href: "/admin/reservas", label: "Reservas", icon: BookOpenCheck },
  { href: "/admin/experiencias", label: "Experiências", icon: Waves },
  { href: "/admin/configuracoes", label: "Configurações", icon: Settings },
];

function AdminShellContent({ children, profile }: { children: ReactNode; profile: AdminProfile }) {
  const pathname = usePathname();
  const router = useRouter();
  const { notify } = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);
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

  const sidebar = (
    <aside className="flex h-full w-72 flex-col border-r border-white/10 bg-ink px-5 py-6 text-white">
      <div className="flex items-center justify-between px-2">
        <Link href="/admin" onClick={() => setMobileOpen(false)} aria-label="Dashboard Alma Azul">
          <Image src="/images/branding/alma-azul-logo-white.png" alt="Alma Azul" width={160} height={86} className="h-auto w-32" priority />
        </Link>
        <button type="button" onClick={() => setMobileOpen(false)} className="grid size-9 place-items-center rounded-full text-white/70 hover:bg-white/10 lg:hidden" aria-label="Fechar menu">
          <X className="size-5" />
        </button>
      </div>

      <nav className="mt-10 space-y-1" aria-label="Navegação administrativa">
        {navigation.map((item) => {
          const active = item.href === "/admin" ? pathname === item.href : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition",
                active ? "bg-white text-ink shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white",
              )}
            >
              <Icon className="size-[18px]" /> {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-white/10 pt-5">
        <div className="px-3">
          <p className="truncate text-sm font-semibold">{profile.displayName}</p>
          <p className="mt-1 truncate text-xs text-white/45">{profile.email}</p>
        </div>
        <button
          type="button"
          onClick={logout}
          disabled={loggingOut}
          className="mt-4 flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
        >
          <LogOut className="size-[18px]" /> {loggingOut ? "Saindo..." : "Sair"}
        </button>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen bg-[#f3f5f1]">
      <div className="fixed inset-y-0 left-0 z-50 hidden lg:block">{sidebar}</div>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 bg-ink/55 backdrop-blur-sm lg:hidden" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setMobileOpen(false);
        }}>
          {sidebar}
        </div>
      ) : null}
      <div className="lg:pl-72">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-ink/10 bg-white/90 px-4 backdrop-blur-lg lg:hidden">
          <button type="button" onClick={() => setMobileOpen(true)} className="grid size-10 place-items-center rounded-full text-ink hover:bg-ink/5" aria-label="Abrir menu">
            <Menu className="size-5" />
          </button>
          <Image src="/images/branding/alma-azul-logo-dark.png" alt="Alma Azul" width={120} height={65} className="h-auto w-24" />
          <div className="size-10" />
        </header>
        <main className="mx-auto min-h-screen max-w-[1500px] p-5 sm:p-8 lg:p-10 xl:p-12">{children}</main>
      </div>
    </div>
  );
}

export function AdminShell({ children, profile }: { children: ReactNode; profile: AdminProfile }) {
  return <ToastProvider><AdminShellContent profile={profile}>{children}</AdminShellContent></ToastProvider>;
}
