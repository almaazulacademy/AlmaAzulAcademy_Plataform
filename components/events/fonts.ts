import { Montserrat } from "next/font/google";

/**
 * Fonte dos títulos dos eventos especiais: geométrica e pesada, como no
 * carrossel oficial. Carregada só nas páginas de evento (variável
 * `--font-event`, classe `font-event`); o resto do site não muda.
 */
export const eventDisplayFont = Montserrat({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
  variable: "--font-event",
});
