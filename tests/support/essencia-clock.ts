/**
 * Relógio dos testes dos roteiros do ESSÊNCIA.
 *
 * Os roteiros (cadastro, atualização editorial, publicação e ajuste com o
 * evento publicado) foram escritos e executados em produção antes do evento,
 * que aconteceu em 07/11/2026 (`ESSENCIA_STARTS_AT`, a data histórica, não
 * muda). O banco recusa sessão no passado (`SESSION_MUST_BE_FUTURE`) e só
 * vende sessão futura — então, sem relógio controlado, os testes deixaram de
 * passar no dia seguinte ao evento.
 *
 * Aqui o "agora" começa em 31/10/2026, 12h em Brasília — o dia em que a
 * publicação e o ajuste editorial rodaram em produção — e anda normalmente.
 * Importar como o PRIMEIRO import do arquivo de teste, antes de criar o banco.
 */

import { ESSENCIA_STARTS_AT } from "../../lib/events/fixtures/essencia.ts";
import { installControlledClock } from "./controlled-clock.ts";

export const ESSENCIA_TEST_NOW = "2026-10-31T15:00:00.000Z";

if (Date.parse(ESSENCIA_TEST_NOW) >= Date.parse(ESSENCIA_STARTS_AT)) {
  throw new Error("essencia-clock: o relógio dos roteiros precisa começar antes do evento");
}

installControlledClock(ESSENCIA_TEST_NOW);
