/**
 * Repara uma planilha operacional já em uso.
 *
 *   pnpm sheets:repair            # dry-run: mostra o plano, não escreve nada
 *   pnpm sheets:repair --apply    # executa
 *
 * Conserta os dois defeitos encontrados no primeiro uso em produção:
 *
 *   1. Cabeçalhos empurrados para baixo por `values.append`. O reparo recoloca
 *      o cabeçalho na linha 1 e os dados a partir da linha 2, **na mesma ordem
 *      em que já estavam**.
 *
 *   2. Fórmulas da `Lista da Sessão` gravadas com vírgula em uma planilha
 *      `pt_BR`, que a API aceita mas o Sheets não avalia (`#ERROR!`). O reparo
 *      reescreve todas com o separador do idioma real da planilha e reconfigura
 *      o dropdown de sessão.
 *
 * Nenhuma linha de dado é descartada. Linhas com a mesma chave são preservadas
 * como estão — quem as neutraliza é a sincronização seguinte, que já sabe lidar
 * com duplicata sem apagar histórico. A única limpeza feita é da cauda que
 * sobra *abaixo* do bloco reescrito, e só depois de todo o conteúdo ter sido
 * regravado acima.
 */

import { createSheetsClient, type SheetsClient } from "../../lib/integrations/google-sheets/client.ts";
import { readGoogleSheetsConfig } from "../../lib/integrations/google-sheets/config.ts";
import { GoogleSheetsError } from "../../lib/integrations/google-sheets/errors.ts";
import {
  argumentSeparatorFor,
  listFormulaCells,
  sessionLookupFormula,
  sessionRevenueFormula,
} from "../../lib/integrations/google-sheets/formulas.ts";
import {
  a1,
  columnLetter,
  FIRST_DATA_ROW,
  LIST_FIRST_DATA_ROW,
  LIST_HEADERS,
  LIST_MAX_SPOTS,
  LIST_TAB,
  sessionLabelRange,
  TAB_HEADERS,
} from "../../lib/integrations/google-sheets/schema.ts";

/** Teto de leitura por aba. Muito acima do volume operacional esperado. */
const SCAN_ROWS = 5000;

type Spreadsheet = {
  properties?: { title?: string; locale?: string };
  sheets?: Array<{ properties?: { sheetId: number; title?: string } }>;
};

function parseArgs(argv: string[]) {
  return { apply: argv.includes("--apply") };
}

type TabPlan = {
  tab: string;
  headerRow: number | null;
  dataRows: string[][];
  duplicateKeys: string[];
  previousExtent: number;
  needsRewrite: boolean;
};

/**
 * Lê a aba inteira e decide o que precisa mudar.
 *
 * O cabeçalho é reconhecido pelas duas primeiras colunas, que são estáveis e
 * não colidem com nenhum dado real (`reservation_id`, `session_id`, `spot_key`).
 */
async function planTab(client: SheetsClient, tab: string, headers: readonly string[]): Promise<TabPlan> {
  const width = columnLetter(headers.length);
  const [rows] = await client.batchGet([a1(tab, `A1:${width}${SCAN_ROWS}`)]);

  let headerRow: number | null = null;
  const dataRows: string[][] = [];
  const seen = new Set<string>();
  const duplicateKeys: string[] = [];

  rows.forEach((row, offset) => {
    const isHeader = (row[0] ?? "") === headers[0] && (row[1] ?? "") === headers[1];
    if (isHeader) {
      // Só o primeiro cabeçalho encontrado conta; um segundo seria lixo e vira dado
      // nenhum — mas isso nunca aconteceu e não vale inventar tratamento.
      if (headerRow === null) headerRow = offset + 1;
      return;
    }
    const key = (row[0] ?? "").trim();
    if (!key) return;
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);
    // Normaliza a largura para a escrita não deixar sobra de coluna antiga.
    dataRows.push(Array.from({ length: headers.length }, (_, i) => row[i] ?? ""));
  });

  const previousExtent = rows.length;
  const jaCorreto = headerRow === 1
    && dataRows.length === Math.max(0, previousExtent - 1);

  return { tab, headerRow, dataRows, duplicateKeys, previousExtent, needsRewrite: !jaCorreto };
}

async function rewriteTab(client: SheetsClient, plan: TabPlan, headers: readonly string[]) {
  const width = columnLetter(headers.length);
  const block: string[][] = [[...headers], ...plan.dataRows];

  // Guarda dura: nunca reescrever perdendo linha. Só segue se o bloco novo
  // contiver tudo que foi lido como dado.
  if (block.length - 1 !== plan.dataRows.length) throw new Error("REPAIR_ROW_COUNT_MISMATCH");

  await client.writeValues(a1(plan.tab, `A1:${width}${block.length}`), block, "RAW");

  // Só agora, com todo o conteúdo já regravado acima, limpa a cauda que sobrou.
  const lastWritten = block.length;
  if (plan.previousExtent > lastWritten) {
    await client.clearValues(a1(plan.tab, `A${lastWritten + 1}:${width}${plan.previousExtent}`));
  }
}

function listScaffold(separator: string) {
  return [
    ["LISTA DA SESSÃO — ALMA AZUL ACADEMY", "", "", "", "", "", "", ""],
    ["Sessão", "", "", "", "", "", "", ""],
    [
      "Experiência", sessionLookupFormula(2, separator),
      "Data", sessionLookupFormula(3, separator),
      "Horário", sessionLookupFormula(4, separator),
      "Status", sessionLookupFormula(8, separator),
    ],
    [
      "Capacidade", sessionLookupFormula(5, separator),
      "Confirmados", sessionLookupFormula(6, separator),
      "Vagas restantes", sessionLookupFormula(7, separator),
      "Total arrecadado", sessionRevenueFormula(separator),
    ],
    [...LIST_HEADERS],
  ];
}

async function repairList(client: SheetsClient, sheetId: number, separator: string) {
  await client.writeValues(
    a1(LIST_TAB, `A1:${columnLetter(LIST_HEADERS.length)}${LIST_FIRST_DATA_ROW - 1}`),
    listScaffold(separator),
    "USER_ENTERED",
  );
  await client.writeValues(
    a1(LIST_TAB, `A${LIST_FIRST_DATA_ROW}:A${LIST_FIRST_DATA_ROW + LIST_MAX_SPOTS - 1}`),
    Array.from({ length: LIST_MAX_SPOTS }, (_, index) => [index + 1]),
    "RAW",
  );
  for (const { cell, formula } of listFormulaCells(separator)) {
    if (!cell.startsWith("J") && cell !== `B${LIST_FIRST_DATA_ROW}`) continue;
    await client.writeValues(a1(LIST_TAB, cell), [[formula]], "USER_ENTERED");
  }

  // Dropdown explícito sobre os rótulos reais das sessões.
  await client.updateSpreadsheet([
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: "ONE_OF_RANGE",
            values: [{ userEnteredValue: sessionLabelRange() }],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },
  ]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readGoogleSheetsConfig();
  if (!config) {
    console.error("Configuração ausente. Defina as variáveis do Google antes de rodar o reparo.");
    process.exitCode = 1;
    return;
  }

  const client = createSheetsClient(config);
  const meta = await client.getSpreadsheet<Spreadsheet>("properties(title,locale),sheets.properties(sheetId,title)");
  const locale = meta.properties?.locale ?? "";
  const separator = argumentSeparatorFor(locale);

  console.info(`Planilha: ${meta.properties?.title ?? "(sem título)"}`);
  console.info(`Idioma: ${locale || "(desconhecido)"} → separador de fórmulas "${separator}"`);
  console.info("");

  const plans: Array<{ plan: TabPlan; headers: readonly string[] }> = [];
  for (const [tab, headers] of Object.entries(TAB_HEADERS)) {
    const plan = await planTab(client, tab, headers);
    plans.push({ plan, headers });

    const posicao = plan.headerRow === null ? "AUSENTE" : `linha ${plan.headerRow}`;
    console.info(`${tab}`);
    console.info(`  cabeçalho hoje : ${posicao}${plan.headerRow === 1 ? " (correto)" : " → será movido para a linha 1"}`);
    console.info(`  linhas de dados: ${plan.dataRows.length} (preservadas, a partir da linha ${FIRST_DATA_ROW})`);
    if (plan.duplicateKeys.length) {
      console.info(`  chaves repetidas: ${plan.duplicateKeys.length} — preservadas; a próxima sincronização as neutraliza`);
    }
    console.info(`  ação           : ${plan.needsRewrite ? "reescrever bloco" : "nada a fazer"}`);
  }

  console.info("");
  console.info(`${LIST_TAB}`);
  console.info(`  fórmulas       : reescritas com separador "${separator}"`);
  console.info(`  dropdown       : ${LIST_TAB}!B2 → ${sessionLabelRange()}`);

  if (!options.apply) {
    console.info("\nDry-run: nada foi escrito. Rode de novo com --apply para executar.");
    return;
  }

  for (const { plan, headers } of plans) {
    if (!plan.needsRewrite) continue;
    await rewriteTab(client, plan, headers);
    console.info(`\n${plan.tab}: cabeçalho na linha 1, ${plan.dataRows.length} linhas de dados preservadas.`);
  }

  const listSheetId = (meta.sheets ?? []).find((s) => s.properties?.title === LIST_TAB)?.properties?.sheetId;
  if (listSheetId === undefined) {
    console.error(`Aba "${LIST_TAB}" não encontrada. Rode o setup antes do reparo.`);
    process.exitCode = 1;
    return;
  }
  await repairList(client, listSheetId, separator);

  console.info("\nReparo concluído. Nenhuma linha de dados foi apagada.");
  console.info("Confirme com `pnpm sheets:verify`.");
}

main().catch((error: unknown) => {
  const code = error instanceof GoogleSheetsError ? error.code : "UNEXPECTED_ERROR";
  console.error(`Falha no reparo da planilha: ${code}`);
  process.exitCode = 1;
});
