/**
 * Verifica a planilha operacional contra a estrutura esperada.
 *
 *   pnpm sheets:verify
 *
 * Somente leitura. Sai com código 1 se qualquer verificação falhar, para servir
 * de portão depois do setup ou do reparo.
 *
 * A verificação decisiva é a do `effectiveValue`. Ler as fórmulas com
 * `valueRenderOption=FORMULA` só prova que a célula guarda uma fórmula — foi
 * assim que dez fórmulas quebradas passaram por aprovadas na primeira vez. Uma
 * fórmula com separador errado fica gravada normalmente e mesmo assim devolve
 * `errorValue: ERROR`. Por isso aqui se lê o valor *avaliado* de cada célula.
 *
 * Nada de dado pessoal é impresso: o relatório mostra endereço de célula,
 * contagem e tipo de erro, nunca o conteúdo de uma linha de participante.
 */

import { createSheetsClient } from "../../lib/integrations/google-sheets/client.ts";
import { readGoogleSheetsConfig } from "../../lib/integrations/google-sheets/config.ts";
import { GoogleSheetsError } from "../../lib/integrations/google-sheets/errors.ts";
import { argumentSeparatorFor, listFormulaCells } from "../../lib/integrations/google-sheets/formulas.ts";
import {
  a1,
  columnLetter,
  FIRST_DATA_ROW,
  LIST_TAB,
  sessionLabelRange,
  SESSIONS_TAB,
  TAB_HEADERS,
} from "../../lib/integrations/google-sheets/schema.ts";

type Cell = {
  userEnteredValue?: { formulaValue?: string };
  effectiveValue?: { errorValue?: { type?: string } };
  dataValidation?: { condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> } };
};

type Grid = { properties?: { locale?: string; title?: string }; sheets?: Array<{ data?: Array<{ rowData?: Array<{ values?: Cell[] }> }> }> };

const failures: string[] = [];

function check(ok: boolean, label: string, detail = "") {
  console.info(`  ${ok ? "OK  " : "FALHA"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function main() {
  const config = readGoogleSheetsConfig();
  if (!config) {
    console.error("Configuração ausente. Defina as variáveis do Google antes de verificar.");
    process.exitCode = 1;
    return;
  }

  const client = createSheetsClient(config);
  const meta = await client.getSpreadsheet<{ properties?: { title?: string; locale?: string } }>("properties(title,locale)");
  const locale = meta.properties?.locale ?? "";
  const separator = argumentSeparatorFor(locale);

  console.info(`Planilha: ${meta.properties?.title ?? "(sem título)"}`);
  console.info(`Idioma: ${locale} → separador esperado "${separator}"`);

  // 1. Cabeçalho na linha 1 e dados a partir da linha 2.
  console.info("\nCabeçalhos:");
  for (const [tab, headers] of Object.entries(TAB_HEADERS)) {
    const width = columnLetter(headers.length);
    const [rows] = await client.batchGet([a1(tab, `A1:${width}${FIRST_DATA_ROW}`)]);
    const header = rows[0] ?? [];
    const alinhado = headers.every((expected, i) => (header[i] ?? "") === expected);
    check(alinhado, `${tab}: cabeçalho completo na linha 1`, alinhado ? "" : `linha 1 começa com "${(header[0] ?? "").slice(0, 24)}"`);

    const segunda = rows[1] ?? [];
    const segundaEhCabecalho = (segunda[0] ?? "") === headers[0];
    check(!segundaEhCabecalho, `${tab}: linha ${FIRST_DATA_ROW} não repete o cabeçalho`);
  }

  // 2. Fórmulas avaliam de verdade.
  console.info("\nFórmulas da Lista da Sessão (effectiveValue):");
  const grid = await client.call<Grid>(
    `?includeGridData=true&ranges=${encodeURIComponent(a1(LIST_TAB, "A1:J8"))}`
    + `&fields=${encodeURIComponent("sheets.data.rowData.values(userEnteredValue.formulaValue,effectiveValue.errorValue.type)")}`,
  );
  const rowData = grid.sheets?.[0]?.data?.[0]?.rowData ?? [];
  const letters = "ABCDEFGHIJ";
  const comErro: string[] = [];
  let comFormula = 0;

  rowData.forEach((row, r) => {
    (row.values ?? []).forEach((cell, c) => {
      if (!cell.userEnteredValue?.formulaValue) return;
      comFormula += 1;
      const erro = cell.effectiveValue?.errorValue?.type;
      if (erro) comErro.push(`${letters[c]}${r + 1} (${erro})`);
    });
  });

  const esperadas = listFormulaCells(separator).length;
  check(comFormula >= esperadas, `${comFormula} células com fórmula`, `esperado ao menos ${esperadas}`);
  check(comErro.length === 0, "nenhuma célula com errorValue", comErro.length ? comErro.join(", ") : "");

  // 3. Dropdown apontando para os rótulos reais das sessões.
  console.info("\nDropdown:");
  const validation = await client.call<Grid>(
    `?includeGridData=true&ranges=${encodeURIComponent(a1(LIST_TAB, "B2"))}`
    + `&fields=${encodeURIComponent("sheets.data.rowData.values.dataValidation")}`,
  );
  const dv = validation.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.dataValidation;
  const esperado = sessionLabelRange();
  const fonte = dv?.condition?.values?.[0]?.userEnteredValue ?? "";
  check(dv?.condition?.type === "ONE_OF_RANGE", "B2 tem validação de intervalo", dv?.condition?.type ?? "ausente");
  check(fonte === esperado, `B2 aponta para ${SESSIONS_TAB}!J2:J1000`, fonte || "ausente");

  console.info("");
  if (failures.length) {
    console.error(`${failures.length} verificação(ões) falharam.`);
    process.exitCode = 1;
    return;
  }
  console.info("Planilha íntegra: cabeçalhos na linha 1, fórmulas avaliando e dropdown configurado.");
}

main().catch((error: unknown) => {
  const code = error instanceof GoogleSheetsError ? error.code : "UNEXPECTED_ERROR";
  console.error(`Falha na verificação da planilha: ${code}`);
  process.exitCode = 1;
});
