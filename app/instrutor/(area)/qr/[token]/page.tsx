import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireCheckinStaff } from "@/lib/admin/auth";
import { lookupCheckin } from "@/lib/checkin/data";
import { isCheckinToken } from "@/lib/checkin/token";

export const metadata = { title: "Check-in" };

/** Destino do QR lido pela câmera nativa: abre a turma certa, sem registrar presença. */
export default async function InstructorQrPage({ params }: { params: Promise<{ token: string }> }) {
  const context = await requireCheckinStaff();
  const { token } = await params;
  if (!isCheckinToken(token)) notFound();

  const reservation = await lookupCheckin(context.profile.userId, { token: token.toLowerCase() }).catch(() => null);
  if (reservation?.sessionId) redirect(`/instrutor/${reservation.sessionId}?qr=${token.toLowerCase()}`);

  return (
    <div className="space-y-5">
      <AdminErrorState title="QR Code não encontrado" description="Nenhuma reserva corresponde a este QR Code." />
      <Link href="/instrutor" className={buttonVariants({ variant: "outline" })}>Voltar à Lista de Presença</Link>
    </div>
  );
}
