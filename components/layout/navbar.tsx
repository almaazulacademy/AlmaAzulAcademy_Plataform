"use client";

import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const links = [
  { label: "Experiências", href: "/#experiencias" },
  { label: "Sobre", href: "/#sobre" },
  { label: "Imersão Paranoá", href: "/imersao-paranoa" },
  { label: "Acompanhar reserva", href: "/acompanhar-reserva" },
];

type NavbarProps = {
  overlay?: boolean;
};

export function Navbar({ overlay = false }: NavbarProps) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > Math.max(80, window.innerHeight * 0.72));
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => {
    if (!open) return;

    const scrollY = window.scrollY;
    const previousStyles = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    return () => {
      Object.assign(document.body.style, previousStyles);
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed left-0 top-0 z-[100] w-full transition-all duration-500",
        open
          ? "bg-transparent text-ink"
          : overlay && !scrolled
          ? "bg-transparent text-white"
          : "border-b border-ink/5 bg-white/85 text-ink shadow-[0_10px_35px_rgba(20,49,44,0.08)] backdrop-blur-xl",
      )}
    >
      <div className="container flex h-24 items-center justify-between">
        <Link href="/" aria-label="Alma Azul Academy — início" className="relative z-50 transition-transform hover:scale-[1.02]">
          <Image
            src={
              open || scrolled
                ? "/images/branding/alma-azul-logo-dark.png"
                : overlay
                ? "/images/branding/alma-azul-logo-white.png"
                : "/images/branding/alma-azul-logo-dark.png"
            }
            alt="Alma Azul"
            width={185}
            height={100}
            className="h-auto w-[132px] sm:w-[150px]"
            priority
          />
        </Link>

        <nav className="hidden items-center gap-8 lg:flex" aria-label="Navegação principal">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "text-sm font-medium transition-opacity hover:opacity-60",
                overlay && !scrolled ? "text-white" : "text-ink",
              )}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/imersao-paranoa#reservas"
            className={buttonVariants({ variant: overlay && !scrolled ? "light" : "default", size: "sm" })}
          >
            Reservar vaga
          </Link>
        </nav>

        <button
          type="button"
          className={cn(
            "relative z-50 grid size-11 place-items-center rounded-full border lg:hidden",
            open
              ? "border-ink/15 bg-white text-ink"
              : overlay && !scrolled
                ? "border-white/40 text-white"
                : "border-ink/15 text-ink",
          )}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? "Fechar menu" : "Abrir menu"}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      <div
        className={cn(
          "fixed inset-0 z-40 flex min-h-[100dvh] flex-col bg-paper px-5 pb-10 pt-32 text-ink transition-all duration-300 lg:hidden",
          open
            ? "visible pointer-events-auto translate-y-0 opacity-100"
            : "invisible pointer-events-none -translate-y-4 opacity-0",
        )}
        aria-hidden={!open}
      >
        <nav className="flex flex-col border-t border-ink/10">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="border-b border-ink/10 py-6 text-2xl font-medium"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/imersao-paranoa#reservas"
          onClick={() => setOpen(false)}
          className={cn(buttonVariants({ size: "lg" }), "mt-auto")}
        >
          Reservar vaga
        </Link>
      </div>
    </header>
  );
}
