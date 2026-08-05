import Image from "next/image";
import Link from "next/link";
import { Instagram, Mail, MessageCircle } from "lucide-react";

import { CONTACT_EMAIL, EMAIL_LINK, WHATSAPP_LINK } from "@/lib/contact";

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
              <Link href="/experiencias/imersao-paranoa" className="transition-colors hover:text-white">Imersão Paranoá</Link>
              <Link href="/acompanhar-reserva" className="transition-colors hover:text-white">Acompanhar reserva</Link>
            </div>
          </div>
          <div>
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
              Conecte-se
            </p>
            <div className="flex flex-col gap-3 text-sm text-white/75">
              <span className="inline-flex items-center gap-2"><Instagram className="size-4" /> Instagram</span>
              <a
                href={WHATSAPP_LINK}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Conversar no WhatsApp com a Alma Azul Academy"
                className="inline-flex items-center gap-2 transition-colors hover:text-white"
              >
                <MessageCircle className="size-4" /> WhatsApp
              </a>
              <a
                href={EMAIL_LINK}
                aria-label={`Enviar e-mail para ${CONTACT_EMAIL}`}
                className="inline-flex items-center gap-2 transition-colors hover:text-white"
              >
                <Mail className="size-4" /> {CONTACT_EMAIL}
              </a>
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
