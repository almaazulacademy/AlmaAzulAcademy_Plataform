import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAdminContext } from "@/lib/admin/auth";
import { renderCheckinQrSvg } from "@/lib/checkin/qr-image";
import { isCheckinToken } from "@/lib/checkin/token";
import { getPublicCheckinTicket } from "@/lib/checkin/data";
import { formatSessionDate, formatSessionTime } from "@/lib/sessions/date-time";

export const metadata: Metadata = {
  title: "QR Code de check-in",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Página aberta pelo QR (ou pelo botão do e-mail).
 *
 * Para o cliente, é só o ingresso: o QR em tamanho grande e a experiência, a
 * data e as vagas — sem nome, e-mail, telefone ou código da reserva. Nada aqui
 * registra presença.
 *
 * Para um instrutor logado que leu o QR com a câmera nativa do celular, a página
 * encaminha para o painel, onde a presença é confirmada com autenticação.
 */
export default async function CheckinTicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isCheckinToken(token)) notFound();
  const normalized = token.toLowerCase();

  if (await getAdminContext().catch(() => null)) redirect(`/admin/presenca/qr/${normalized}`);

  const ticket = await getPublicCheckinTicket(normalized).catch(() => null);
  const svg = ticket ? await renderCheckinQrSvg(normalized) : null;

  return (
    <main className="min-h-screen bg-paper px-4 py-10">
      <div className="mx-auto w-full max-w-sm">
        <Link href="/" className="mx-auto block w-28">
          <Image src="/images/branding/alma-azul-logo-dark.png" alt="Alma Azul Academy" width={160} height={86} className="h-auto w-28" priority />
        </Link>
        {ticket && svg ? (
          <section className="mt-8 rounded-[2rem] bg-white p-6 text-center shadow-sm ring-1 ring-ink/10">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lake">Seu QR Code de check-in</p>
            <div className="mx-auto mt-5 w-full max-w-[280px] [&_svg]:h-auto [&_svg]:w-full" aria-label="QR Code de check-in" role="img" dangerouslySetInnerHTML={{ __html: svg }} />
            <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-ink">{ticket.experienceTitle}</h1>
            <p className="mt-2 text-sm capitalize text-ink/70">{formatSessionDate(ticket.startsAt)}</p>
            <p className="mt-1 text-lg font-semibold text-forest">{formatSessionTime(ticket.startsAt)}</p>
            <p className="mt-3 text-sm text-ink/70">{ticket.quantity} {ticket.quantity === 1 ? "vaga reservada" : "vagas reservadas"}</p>
            <p className="mt-6 rounded-2xl bg-mist/70 p-4 text-sm leading-6 text-ink/75">
              {ticket.checkedIn
                ? "Check-in já realizado. Boa remada!"
                : "No dia da experiência, apresente este QR Code à nossa equipe para realizar seu check-in."}
            </p>
          </section>
        ) : (
          <section className="mt-8 rounded-[2rem] bg-white p-6 text-center shadow-sm ring-1 ring-ink/10">
            <h1 className="text-xl font-semibold text-ink">QR Code não encontrado</h1>
            <p className="mt-3 text-sm leading-6 text-ink/65">Este QR não corresponde a uma reserva confirmada. Se precisar de ajuda, fale com a nossa equipe.</p>
          </section>
        )}
      </div>
    </main>
  );
}
