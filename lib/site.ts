/**
 * Domínio público oficial da Alma Azul Academy.
 *
 * Fonte única para metadataBase, canonical, Open Graph, Twitter, sitemap e robots.
 * Não usar NEXT_PUBLIC_SITE_URL aqui: aquela variável serve à lógica da aplicação
 * (retorno e webhook do checkout, checagem de origem no admin) e pode apontar para
 * um preview. O canônico precisa ser sempre o domínio de produção.
 */
export const SITE_URL = "https://almaazulacademy.com.br";

export const SITE_NAME = "Alma Azul Academy";

/** Imagem padrão de compartilhamento — resolvida contra metadataBase. */
export const SITE_OG_IMAGE = "/images/backgrounds/hero-alma-azul-lago.webp";

/** Monta uma URL absoluta pública a partir de um caminho relativo. */
export function absoluteUrl(path: string) {
  return new URL(path, SITE_URL).toString();
}
