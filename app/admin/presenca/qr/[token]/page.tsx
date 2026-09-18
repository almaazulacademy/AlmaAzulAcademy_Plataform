import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { lookupCheckin } from "@/lib/checkin/data";
import { isCheckinToken } from "@/lib/checkin/token";

export const metadata = { title: "Check-in" };

/**
 * Destino do QR lido pela câmera nativa do celular de um instrutor logado.
 * Só abre a turma certa com a reserva selecionada: a presença continua exigindo
 * a confirmação na tela.
 */
export default async function AttendanceQrPage({ params }: { params: Promise<{ token: string }> }) {
  const context = await requireAdmin();
  const { token } = await params;
  if (!isCheckinToken(token)) notFound();

  const reservation = await lookupCheckin(context.profile.userId, { token: token.toLowerCase() }).catch(() => null);
  if (reservation?.sessionId) redirect(`/admin/presenca/${reservation.sessionId}?qr=${token.toLowerCase()}`);

  return (
    <div className="space-y-5">
      <AdminErrorState title="QR Code não encontrado" description="Nenhuma reserva corresponde a este QR Code." />
      <Link href="/admin/presenca" className={buttonVariants({ variant: "outline" })}>Ir para a Lista de Presença</Link>
    </div>
  );
}
