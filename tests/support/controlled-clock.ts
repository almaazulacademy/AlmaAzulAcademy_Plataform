/**
 * Relógio controlado para testes que reproduzem um momento histórico.
 *
 * Desloca o relógio do processo para que "agora" comece no instante pedido e
 * continue andando normalmente dali em diante. Vale para o JavaScript (`Date.now()`,
 * `new Date()` sem argumentos, `Date()`) e para o Postgres em memória: o PGlite
 * lê a hora pelo `Date.now()` do processo, então `now()`, `clock_timestamp()` e
 * `statement_timestamp()` passam a ver o mesmo instante. Nada muda em datas
 * explícitas (`new Date("2026-11-07T08:30:00Z")`, `Date.parse`, `Date.UTC`).
 *
 * O runner do Node executa cada arquivo de teste num processo próprio, então o
 * deslocamento fica restrito ao arquivo que importa o relógio. Ele precisa ser
 * instalado antes de qualquer banco ser criado: importe o módulo que o instala
 * como o primeiro import do arquivo.
 */

const RealDate = Date;
let installed: { startsAt: number; offset: number } | null = null;

export function controlledNow() {
  return RealDate.now() - (installed?.offset ?? 0);
}

/** Instala o relógio começando em `startIso`. Instalar de novo com outro instante é erro. */
export function installControlledClock(startIso: string) {
  const startsAt = RealDate.parse(startIso);
  if (Number.isNaN(startsAt)) throw new Error(`controlled-clock: instante inválido ${startIso}`);
  if (installed) {
    if (installed.startsAt !== startsAt) throw new Error("controlled-clock: já instalado com outro instante");
    return;
  }
  installed = { startsAt, offset: RealDate.now() - startsAt };

  const ControlledDate = new Proxy(RealDate, {
    // `new Date()` sem argumentos usa o relógio controlado; com argumentos, nada muda.
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [controlledNow()] : args, newTarget);
    },
    // `Date()` chamado como função devolve o texto do instante atual.
    apply() {
      return new RealDate(controlledNow()).toString();
    },
    get(target, property, receiver) {
      if (property === "now") return controlledNow;
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = ControlledDate as DateConstructor;
}
