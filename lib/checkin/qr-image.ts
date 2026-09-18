import QRCode from "qrcode";

import { checkinUrl } from "@/lib/checkin/token";

/**
 * PNG do QR de check-in. Só codifica a URL com o token — nada pessoal — e não
 * consulta o banco: a imagem é a mesma para qualquer um que tenha o token.
 */
export function renderCheckinQrPng(token: string) {
  return QRCode.toBuffer(checkinUrl(token), {
    type: "png",
    width: 480,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#14312c", light: "#ffffff" },
  });
}

/** SVG do mesmo QR, para exibir no navegador (página pública). */
export function renderCheckinQrSvg(token: string) {
  return QRCode.toString(checkinUrl(token), {
    type: "svg",
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#14312c", light: "#ffffff" },
  });
}
