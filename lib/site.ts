/**
 * Domínio público oficial da Alma Azul Academy.
 *
 * Fonte única para metadataBase, canonical, Open Graph, Twitter, sitemap, robots
 * e — o que torna esta constante crítica — para o **fallback de origem do
 * checkout**: `publicOrigin()` em `app/api/reservations/route.ts` cai aqui
 * sempre que `NEXT_PUBLIC_SITE_URL` estiver ausente, inválida, apontando para
 * localhost ou para um preview.
 *
 * ## Por que `www` e não o domínio raiz
 *
 * O domínio canônico servido pela Vercel em produção é `www`. O domínio raiz
 * responde **308 para qualquer requisição**, inclusive POST, no edge — antes de
 * a aplicação rodar:
 *
 *   POST https://almaazulacademy.com.br/api/payments/infinitepay/webhook
 *     → 308 Location: https://www.almaazulacademy.com.br/api/...
 *
 * Um 308 preserva método e corpo por definição, mas só para clientes que
 * **seguem** o redirecionamento. Gateway de pagamento com frequência não segue,
 * ou trata 3xx como falha de entrega. Com o domínio raiz aqui, um checkout
 * criado sem `NEXT_PUBLIC_SITE_URL` registrava na InfinitePay um `webhook_url`
 * que redireciona, e a confirmação nunca chegava — o pagamento acontecia e a
 * vaga era liberada.
 *
 * O `redirect_url` do cliente sofria o mesmo 308, mas navegador segue
 * redirecionamento: por isso o retorno continuava confirmando e o webhook
 * falhava calado. Era essa assimetria que escondia o problema.
 *
 * Não usar `NEXT_PUBLIC_SITE_URL` aqui: aquela variável serve à lógica da
 * aplicação e pode apontar para um preview. O canônico precisa ser sempre o
 * domínio de produção — e o fallback precisa ser um host que responda
 * diretamente, nunca um que redirecione.
 *
 * Se o domínio canônico da Vercel mudar, esta constante muda junto. O teste em
 * `tests/canonical-domain.test.ts` recusa qualquer host que volte a redirecionar.
 */
export const SITE_URL = "https://www.almaazulacademy.com.br";

export const SITE_NAME = "Alma Azul Academy";

/** Imagem padrão de compartilhamento — resolvida contra metadataBase. */
export const SITE_OG_IMAGE = "/images/backgrounds/hero-alma-azul-lago.webp";

/** Monta uma URL absoluta pública a partir de um caminho relativo. */
export function absoluteUrl(path: string) {
  return new URL(path, SITE_URL).toString();
}
