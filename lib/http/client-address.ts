/**
 * Endereço do cliente para o limite de tentativas — só de fonte confiável.
 *
 * Cabeçalho é texto que o cliente escreve. Só deixa de ser quando a plataforma
 * o reescreve antes de a requisição chegar à aplicação. Na Vercel:
 *
 *   - `x-forwarded-for` é sobrescrito na borda "para evitar falsificação de IP"
 *     e não repassa endereços externos;
 *   - `x-real-ip` e `x-vercel-forwarded-for` são idênticos a ele, e o segundo
 *     continua correto mesmo com um proxy na frente da Vercel.
 *
 * (https://vercel.com/docs/headers/request-headers)
 *
 * Fora da Vercel — `next dev`, `next start`, outro provedor — esses mesmos
 * cabeçalhos chegam como o cliente os mandou. Ali nenhum deles é lido: o
 * endereço é desconhecido, e o banco aplica só o limite da credencial. Nunca um
 * balde comum a todos, que deixaria um abusador travar a consulta de todo mundo.
 *
 * O valor precisa ser um IP literal. IPv6 é agrupado no prefixo /64 — o bloco
 * que um provedor entrega a um único cliente —, para que trocar o endereço
 * dentro do próprio bloco não renda tentativas novas.
 *
 * Sem dependência de Node: o mesmo arquivo roda em qualquer runtime.
 */

type Env = Record<string, string | undefined>;

function readEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** A aplicação está atrás da borda da Vercel. `VERCEL=1` é uma variável de sistema da plataforma. */
export function isBehindVercelEdge(env: Env = readEnv()) {
  return env.VERCEL === "1";
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Os oito grupos de um IPv6, ou null. Aceita `::` e IPv4 embutido no fim. */
function ipv6Groups(value: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(value) || value.length > 45) return null;
  let text = value.toLowerCase();

  // IPv4 no fim (`::ffff:203.0.113.9`) vira os dois últimos grupos.
  const tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (!IPV4.test(tail[1])) return null;
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...rest];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Normaliza um IP literal: IPv4 como está; IPv4 mapeado em IPv6 como IPv4;
 * IPv6 reduzido ao prefixo /64. Qualquer outra coisa é null.
 */
export function normalizeClientIp(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (IPV4.test(text)) return text;
  const groups = ipv6Groups(text);
  if (!groups) return null;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * O endereço para o balde de origem, ou "" quando não há um confiável.
 *
 * Na Vercel, `x-vercel-forwarded-for` primeiro e `x-real-ip` na falta dele; de
 * uma lista, só o primeiro item (a Vercel grava um só). Fora da Vercel, sempre "".
 */
export function trustedClientAddress(headers: Pick<Headers, "get">, env: Env = readEnv()): string {
  if (!isBehindVercelEdge(env)) return "";
  for (const name of ["x-vercel-forwarded-for", "x-real-ip"]) {
    const first = headers.get(name)?.split(",")[0];
    const address = normalizeClientIp(first);
    if (address) return address;
  }
  return "";
}
