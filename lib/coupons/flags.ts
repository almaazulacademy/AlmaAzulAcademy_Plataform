/**
 * Interruptores dos cupons de desconto. Os dois nascem desligados e nada no
 * site os lê na fase 2: o banco e as regras chegam antes de qualquer tela.
 *
 * `COUPONS_ADMIN_ENABLED=true` abre a seção Marketing → Cupons do painel
 * (fase 3). Desligada, o item some do menu e as rotas do painel respondem 404.
 *
 * `COUPONS_CHECKOUT_ENABLED=true` abre o campo "Tem um cupom de desconto?" na
 * reserva e faz `POST /api/reservations` aceitar um código (fases 4 e 5).
 * Desligada, o campo não aparece e a API recusa um código enviado — nunca cobra
 * o preço cheio em silêncio no lugar de um desconto pedido.
 *
 * Mesmo ligado, o checkout só aplica cupom depois que
 * `coupon_settings.min_charge_cents` for gravado no banco com o mínimo
 * confirmado da InfinitePay.
 */

export function isCouponsAdminEnabled(env: Record<string, string | undefined> = process.env) {
  return env.COUPONS_ADMIN_ENABLED === "true";
}

export function isCouponsCheckoutEnabled(env: Record<string, string | undefined> = process.env) {
  return env.COUPONS_CHECKOUT_ENABLED === "true";
}
