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
];

type NavbarProps = {
  overlay?: boolean;
};

export function Navbar({ overlay = false }: NavbarProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "z-50 w-full",
        overlay ? "absolute left-0 top-0 text-white" : "relative bg-paper text-ink",
      )}
    >
      <div className="container flex h-24 items-center justify-between">
        <Link href="/" aria-label="Alma Azul Academy — início" className="relative z-50">
          <Image
            src={
              open
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
                overlay ? "text-white" : "text-ink",
              )}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/imersao-paranoa#reserva"
            className={buttonVariants({ variant: overlay ? "light" : "default", size: "sm" })}
          >
            Ver experiência
          </Link>
        </nav>

        <button
          type="button"
          className={cn(
            "relative z-50 grid size-11 place-items-center rounded-full border lg:hidden",
            open
              ? "border-ink/15 bg-white text-ink"
              : overlay
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
          "fixed inset-0 z-40 flex flex-col bg-paper px-5 pb-10 pt-32 text-ink transition-all duration-300 lg:hidden",
          open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-4 opacity-0",
        )}
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
          href="/imersao-paranoa#reserva"
          onClick={() => setOpen(false)}
          className={cn(buttonVariants({ size: "lg" }), "mt-auto")}
        >
          Ver experiência
        </Link>
      </div>
    </header>
  );
}
