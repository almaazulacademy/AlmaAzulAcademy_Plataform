import { NextResponse } from "next/server";

import { renderCheckinQrPng } from "@/lib/checkin/qr-image";
import { isCheckinToken } from "@/lib/checkin/token";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ token: string }> };

/**
 * Imagem do QR usada no e-mail.
 *
 * Pública de propósito (clientes de e-mail buscam a imagem sem sessão), mas não
 * revela nada: não consulta o banco, não diz se o token existe e só desenha a
 * URL que já está no próprio QR. O token não muda, então o cache pode ser longo.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;
  const normalized = token.replace(/\.png$/i, "");
  if (!isCheckinToken(normalized)) return NextResponse.json({ message: "QR inválido." }, { status: 404 });

  const png = await renderCheckinQrPng(normalized.toLowerCase());
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "x-robots-tag": "noindex",
    },
  });
}
