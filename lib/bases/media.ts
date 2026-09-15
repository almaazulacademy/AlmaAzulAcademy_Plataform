/**
 * Mídia no modelo multi-base.
 *
 * Dois conceitos separados:
 *
 * - **Mídia da base (espaço):** o lugar — estrutura, entorno, parceiro, chegada.
 *   Não depende de canoa nem de experiência. Vive em
 *   `public/images/bases/<base-slug>/` e `public/videos/bases/<base-slug>/`, e é
 *   referenciada pelo conteúdo da página da base (`lib/bases/content.ts`) e por
 *   `bases.image_url` (foto do card da base).
 *
 * - **Mídia da experiência:** a atividade acontecendo — canoas, remada, pôr do
 *   sol. Vive em `public/images/experiences/<experience-slug>/` e é referenciada
 *   por `experiences.image_url` e `experiences.editorial_content`.
 *
 * Só arquivos locais do acervo oficial: nada de banco de imagens nem URL externa.
 */

export type BaseMediaItem =
  | { kind: "image"; src: string; alt: string }
  | { kind: "video"; src: string; alt: string; poster?: string };

/** Mídia da base só aceita arquivo local versionado — sem HTTPS externo. */
export function isLocalBaseMedia(src: string) {
  return /^\/(images|videos)\/[a-z0-9/_.-]+$/i.test(src) && !src.includes("..");
}

/**
 * Fotos TEMPORÁRIAS por base: imagens do Lago Norte usadas enquanto a base não
 * tem acervo próprio. Enquanto um caminho estiver aqui, o site mostra
 * `TEMPORARY_MEDIA_LABEL` sobre a foto naquela base.
 *
 * Para trocar pela mídia real: coloque os arquivos nas pastas da base/experiência,
 * atualize `bases.image_url`, `experiences.image_url` e `lib/bases/content.ts`,
 * e remova os caminhos daqui. O teste `multi-base.test.ts` lista onde cada um é usado.
 */
export const TEMPORARY_BASE_MEDIA: Record<string, readonly string[]> = {
  "concha-acustica": [
    // Landing da Concha — registros reais da Alma Azul no Lago Paranoá,
    // ainda não produzidos na nova base (ver lib/bases/concha-landing.ts).
    "/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp",
    // Card e hero da base (mídia do espaço) — foto do Lago Norte.
    "/images/experiences/remada-sunset/remada-sunset-sobre.webp",
    // Cards das experiências planejadas (mídia de experiência) — fotos do Lago Norte.
    "/images/backgrounds/hero-alma-azul-lago.webp",
    "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp",
    "/images/experiences/remada-sunset/remada-sunset-hero.webp",
    "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp",
  ],
};

export const TEMPORARY_MEDIA_LABEL = "Registros de experiências Alma Azul no Lago Paranoá";

export function isTemporaryMedia(baseSlug: string, src: string | null | undefined) {
  return Boolean(src && TEMPORARY_BASE_MEDIA[baseSlug]?.includes(src));
}
