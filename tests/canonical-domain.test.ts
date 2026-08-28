/**
 * Domínio canônico e fallback de origem do checkout.
 *
 * ## O risco que estes testes travam
 *
 * `publicOrigin()` monta `webhook_url` e `redirect_url` de cada checkout da
 * InfinitePay. Quando `NEXT_PUBLIC_SITE_URL` está ausente, inválida, apontando
 * para localhost ou para um preview, ele cai em `SITE_URL`.
 *
 * Enquanto `SITE_URL` foi o domínio raiz, esse fallback registrava no gateway
 * uma URL que responde **308 no edge**, inclusive para POST. Gateway que não
 * segue redirecionamento nunca entrega a notificação: o cliente paga, a
 * confirmação não chega e a vaga é liberada.
 *
 * O `redirect_url` sofria o mesmo 308, mas navegador segue redirecionamento —
 * então o retorno continuava confirmando enquanto o webhook falhava calado. Foi
 * essa assimetria que escondeu o problema.
 *
 * A verificação de rede fica de fora daqui de propósito: o CI não fala com a
 * internet. O que estes testes garantem é o invariante que dependia de alguém
 * lembrar — que o fallback é um host que responde diretamente.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { absoluteUrl, SITE_URL } from "../lib/site.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const CANONICAL_HOST = "www.almaazulacademy.com.br";

// --- O invariante central ----------------------------------------------------

test("SITE_URL aponta para o host canônico servido pela Vercel", () => {
  const url = new URL(SITE_URL);
  assert.equal(url.host, CANONICAL_HOST);
  assert.equal(url.protocol, "https:", "o gateway exige HTTPS");
  assert.equal(url.origin, SITE_URL, "sem caminho, query ou barra final");
});

test("o fallback do checkout nunca gera webhook_url no domínio sem www", () => {
  // É esta URL que vai para a InfinitePay em `webhook_url` quando
  // NEXT_PUBLIC_SITE_URL não está utilizável.
  const webhookUrl = `${SITE_URL}/api/payments/infinitepay/webhook`;
  assert.equal(webhookUrl, `https://${CANONICAL_HOST}/api/payments/infinitepay/webhook`);

  const host = new URL(webhookUrl).host;
  assert.ok(host.startsWith("www."), "o domínio raiz responde 308 e o gateway pode não seguir");
  assert.notEqual(host, "almaazulacademy.com.br");
});

test("o retorno do cliente usa o mesmo host canônico", () => {
  const returnUrl = `${SITE_URL}/pagamento/retorno`;
  assert.equal(new URL(returnUrl).host, CANONICAL_HOST);
});

test("absoluteUrl resolve contra o host canônico", () => {
  assert.equal(absoluteUrl("/sitemap.xml"), `https://${CANONICAL_HOST}/sitemap.xml`);
  assert.equal(absoluteUrl("/agenda"), `https://${CANONICAL_HOST}/agenda`);
  // Caminho de imagem do Open Graph, resolvido contra metadataBase.
  assert.equal(
    absoluteUrl("/images/backgrounds/hero-alma-azul-lago.webp"),
    `https://${CANONICAL_HOST}/images/backgrounds/hero-alma-azul-lago.webp`,
  );
});

// --- A ligação entre a constante e o checkout --------------------------------

test("publicOrigin continua caindo em SITE_URL, e não na origem da requisição", () => {
  const route = source("app/api/reservations/route.ts");
  const body = route.slice(route.indexOf("function publicOrigin"), route.indexOf("function reservationError"));

  // Se este fallback deixar de ser SITE_URL, os testes acima param de proteger
  // o que importa — por isso a ligação é verificada explicitamente.
  assert.match(body, /return SITE_URL;/, "o fallback precisa ser a constante canônica");

  // E as recusas que já existiam continuam de pé.
  // O código traz o ponto escapado dentro de um literal de regex.
  assert.match(body, /vercel\\\.app/, "preview nunca pode virar webhook_url");
  assert.match(body, /localhost/, "localhost nunca pode virar webhook_url");
  assert.match(body, /protocol === "https:"/, "o gateway exige HTTPS");
  assert.doesNotMatch(body, /request\./, "a origem da requisição não decide o webhook");
});

test("nenhum módulo da aplicação fixa o domínio raiz em código", () => {
  // Uma reintrodução do domínio raiz em qualquer lugar recria o mesmo incidente.
  // Comentários explicando o problema são permitidos; código não.
  for (const path of [
    "lib/site.ts",
    "app/api/reservations/route.ts",
    "app/layout.tsx",
    "app/robots.ts",
    "app/sitemap.ts",
  ]) {
    // Descartar linha por linha, e não por regex de comentário: um
    // `.replace(/\/\/.*$/gm, "")` cortaria `"https://…"` no próprio `//` da
    // URL e o teste passaria a nunca encontrar nada — deixando de proteger.
    const code = source(path)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*");
      })
      .join("\n");

    assert.doesNotMatch(
      code,
      /["'`]https:\/\/almaazulacademy\.com\.br/,
      `${path} não pode fixar o domínio raiz: ele responde 308`,
    );
  }
});
