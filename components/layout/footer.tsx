import Image from "next/image";
import Link from "next/link";
import { Instagram, Mail } from "lucide-react";

export function Footer() {
  return (
    <footer className="bg-ink text-white">
      <div className="container py-14 sm:py-20">
        <div className="grid gap-12 border-b border-white/15 pb-14 md:grid-cols-[1.4fr_0.6fr_0.6fr]">
          <div>
            <Image
              src="/images/branding/alma-azul-logo-white.png"
              alt="Alma Azul"
              width={210}
              height={114}
              className="h-auto w-40"
            />
            <p className="mt-6 max-w-sm text-base leading-7 text-white/65">
              Experiências na água para respirar fundo, mover o corpo e reencontrar presença.
            </p>
          </div>
          <div>
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
              Explore
            </p>
            <div className="flex flex-col gap-3 text-sm text-white/75">
              <Link href="/" className="transition-colors hover:text-white">Início</Link>
              <Link href="/#experiencias" className="transition-colors hover:text-white">Experiências</Link>
              <Link href="/imersao-paranoa" className="transition-colors hover:text-white">Imersão Paranoá</Link>
            </div>
          </div>
          <div>
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
              Conecte-se
            </p>
            <div className="flex flex-col gap-3 text-sm text-white/75">
              <span className="inline-flex items-center gap-2"><Instagram className="size-4" /> Instagram</span>
              <span className="inline-flex items-center gap-2"><Mail className="size-4" /> Fale com a gente</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 pt-8 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Alma Azul Academy.</p>
          <p>Brasília · Distrito Federal</p>
        </div>
      </div>
    </footer>
  );
}
