/**
 * Prepara (ou conserta) a Planilha Google operacional.
 *
 *   pnpm sheets:setup            # dry-run: mostra o plano, não escreve nada
 *   pnpm sheets:setup --apply    # executa
 *
 * O script é aditivo e idempotente por desenho:
 *
 *   • cria as abas que faltam e nunca apaga uma aba existente;
 *   • escreve cabeçalhos na linha 1 e nunca toca nas linhas de dados de
 *     `Reservas do Site`, `Sessões` ou `Vagas Confirmadas`;
 *   • reescreve a `Lista da Sessão` inteira, porque ela é 100% derivada —
 *     é a única aba sem dado próprio a preservar;
 *   • não emite nenhuma requisição de exclusão. Não há caminho neste arquivo
 *     que remova aba, linha, coluna ou reserva.
 *
 * Rodar duas vezes seguidas produz exatamente o mesmo resultado.
 */

import { createSheetsClient } from "../../lib/integrations/google-sheets/client.ts";
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
  HIDDEN_COLUMNS,
  HIDDEN_TABS,
  LIST_FIRST_DATA_ROW,
  LIST_HEADERS,
  LIST_MAX_SPOTS,
  LIST_TAB,
  RESERVATIONS_TAB,
  sessionLabelRange,
  SESSIONS_TAB,
  SPOTS_TAB,
  SPREADSHEET_LOCALE,
  SPREADSHEET_TIME_ZONE,
  TAB_HEADERS,
  TAB_WIDTHS,
} from "../../lib/integrations/google-sheets/schema.ts";

type SheetProperties = {
  sheetId: number;
  title: string;
  hidden?: boolean;
  gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
};

type Spreadsheet = {
  properties?: { title?: string; locale?: string; timeZone?: string };
  sheets?: Array<{ properties?: SheetProperties }>;
};

const HEADER_BACKGROUND = { red: 0.937, green: 0.949, blue: 0.945 };

/** Colunas cujo valor é dinheiro e precisa aparecer como R$. */
const CURRENCY_COLUMNS: Record<string, number[]> = {
  [RESERVATIONS_TAB]: [10],
  [SPOTS_TAB]: [8],
  [LIST_TAB]: [7],
};

/** Larguras que deixam nome e telefone legíveis sem precisar arrastar coluna. */
const COLUMN_WIDTHS: Record<string, Record<number, number>> = {
  [RESERVATIONS_TAB]: { 4: 190, 7: 220, 8: 160, 11: 130, 12: 150, 13: 150, 15: 150 },
  [SESSIONS_TAB]: { 2: 190, 8: 140, 9: 150 },
  [SPOTS_TAB]: { 6: 220, 7: 160, 11: 260 },
  [LIST_TAB]: { 1: 70, 2: 240, 3: 170, 4: 150, 5: 130, 6: 160, 7: 130, 8: 280 },
};

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes("--apply"),
    quiet: argv.includes("--quiet"),
  };
}

function log(quiet: boolean, message: string) {
  if (!quiet) console.info(message);
}

/**
 * Cabeçalho estático da `Lista da Sessão`.
 *
 * O separador vem do idioma real da planilha: com vírgula em uma planilha
 * `pt_BR` a fórmula é aceita pela API mas nunca avalia, e a célula exibe
 * `#ERROR!`.
 */
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readGoogleSheetsConfig();

  if (!config) {
    console.error(
      "Configuração ausente. Defina GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL e "
      + "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY antes de rodar o setup.",
    );
    process.exitCode = 1;
    return;
  }

  const client = createSheetsClient(config);
  const before = await client.getSpreadsheet<Spreadsheet>(
    "properties(title,locale,timeZone),sheets.properties(sheetId,title,hidden,gridProperties)",
  );

  const existing = new Map<string, SheetProperties>();
  for (const sheet of before.sheets ?? []) {
    if (sheet.properties?.title) existing.set(sheet.properties.title, sheet.properties);
  }

  const wanted = [RESERVATIONS_TAB, SESSIONS_TAB, SPOTS_TAB, LIST_TAB];
  const missing = wanted.filter((tab) => !existing.has(tab));

  // O setup escreve cabeçalho na linha 1. Se uma aba já existente tiver dado
  // ali — o sintoma do bug de append que deslocava cabeçalhos — escrever
  // apagaria esse registro. Aborta e manda usar o reparo, que preserva tudo.
  const deslocadas: string[] = [];
  for (const [tab, headers] of Object.entries(TAB_HEADERS)) {
    if (!existing.has(tab)) continue;
    const [rows] = await client.batchGet([a1(tab, `A1:${columnLetter(headers.length)}1`)]);
    const first = rows[0] ?? [];
    if (first.length && first[0] !== headers[0]) deslocadas.push(tab);
  }
  if (deslocadas.length) {
    console.error(
      `Cabeçalho fora da linha 1 em: ${deslocadas.join(", ")}.\n`
      + "Rode `pnpm sheets:repair` antes do setup — ele recoloca os cabeçalhos preservando os dados.",
    );
    process.exitCode = 1;
    return;
  }

  log(options.quiet, `Planilha: ${before.properties?.title ?? "(sem título)"}`);
  log(options.quiet, `Abas existentes: ${[...existing.keys()].join(", ") || "(nenhuma)"}`);
  log(options.quiet, `Abas a criar: ${missing.join(", ") || "(nenhuma)"}`);
  log(options.quiet, `Idioma/fuso: ${SPREADSHEET_LOCALE} · ${SPREADSHEET_TIME_ZONE}`);
  log(options.quiet, `Separador de fórmulas: "${argumentSeparatorFor(SPREADSHEET_LOCALE)}" (idioma da planilha)`);
  log(options.quiet, `Colunas técnicas escondidas e aba "${SPOTS_TAB}" oculta.`);
  log(options.quiet, `Dropdown de sessão em ${LIST_TAB}!B2, lista de ${LIST_MAX_SPOTS} vagas.`);

  if (!options.apply) {
    log(options.quiet, "\nDry-run: nada foi escrito. Rode de novo com --apply para executar.");
    return;
  }

  // 1. Idioma e fuso primeiro: as fórmulas e a formatação de moeda dependem
  //    deles, e mudar depois deixaria a planilha inconsistente por um instante.
  await client.updateSpreadsheet([
    {
      updateSpreadsheetProperties: {
        properties: { locale: SPREADSHEET_LOCALE, timeZone: SPREADSHEET_TIME_ZONE },
        fields: "locale,timeZone",
      },
    },
    ...missing.map((title) => ({
      addSheet: {
        properties: {
          title,
          hidden: HIDDEN_TABS.includes(title),
          gridProperties: {
            rowCount: title === LIST_TAB ? LIST_FIRST_DATA_ROW + LIST_MAX_SPOTS + 4 : 2000,
            columnCount: TAB_WIDTHS[title] ?? 15,
            frozenRowCount: title === LIST_TAB ? LIST_FIRST_DATA_ROW - 1 : 1,
          },
        },
      },
    })),
  ]);

  // 2. Relê para descobrir o sheetId das abas recém-criadas.
  const after = await client.getSpreadsheet<Spreadsheet>("sheets.properties(sheetId,title,hidden,gridProperties)");
  const sheetIds = new Map<string, number>();
  for (const sheet of after.sheets ?? []) {
    if (sheet.properties?.title) sheetIds.set(sheet.properties.title, sheet.properties.sheetId);
  }

  const requests: unknown[] = [];

  for (const tab of wanted) {
    const sheetId = sheetIds.get(tab);
    if (sheetId === undefined) continue;
    const width = TAB_WIDTHS[tab] ?? 15;
    const headerRow = tab === LIST_TAB ? LIST_FIRST_DATA_ROW - 1 : 1;

    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          hidden: HIDDEN_TABS.includes(tab),
          gridProperties: { frozenRowCount: headerRow },
        },
        fields: "hidden,gridProperties.frozenRowCount",
      },
    });

    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: headerRow - 1, endRowIndex: headerRow, startColumnIndex: 0, endColumnIndex: width },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: HEADER_BACKGROUND,
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor,verticalAlignment)",
      },
    });

    for (const position of HIDDEN_COLUMNS[tab] ?? []) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: position - 1, endIndex: position },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        },
      });
    }

    for (const [position, pixels] of Object.entries(COLUMN_WIDTHS[tab] ?? {})) {
      const index = Number(position);
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: index - 1, endIndex: index },
          properties: { pixelSize: pixels },
          fields: "pixelSize",
        },
      });
    }

    for (const position of CURRENCY_COLUMNS[tab] ?? []) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: headerRow, startColumnIndex: position - 1, endColumnIndex: position },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "R$ #,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
  }

  // Dropdown de sessão. A fonte é a coluna de rótulos da aba `Sessões`, que a
  // própria sincronização mantém atualizada — nenhuma lista fixa para manter.
  const listSheetId = sheetIds.get(LIST_TAB);
  if (listSheetId !== undefined) {
    requests.push({
      setDataValidation: {
        range: { sheetId: listSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: "ONE_OF_RANGE",
            values: [{ userEnteredValue: sessionLabelRange() }],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    });
    requests.push({
      mergeCells: {
        range: { sheetId: listSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: LIST_HEADERS.length },
        mergeType: "MERGE_ALL",
      },
    });
  }

  await client.updateSpreadsheet(requests);

  // 3. Cabeçalhos das abas de dados. Só a linha 1 — nenhuma reserva é tocada.
  for (const [tab, headers] of Object.entries(TAB_HEADERS)) {
    await client.writeValues(a1(tab, `A1:${columnLetter(headers.length)}1`), [[...headers]], "RAW");
  }

  // 4. Estrutura da `Lista da Sessão`. Reescrita inteira porque é derivada:
  //    não existe dado digitado ali para preservar.
  const separator = argumentSeparatorFor(SPREADSHEET_LOCALE);
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
  // As células fora do bloco do cabeçalho (o session_id técnico e o corpo da
  // lista) vêm da mesma lista central que a verificação usa depois.
  for (const { cell, formula } of listFormulaCells(separator)) {
    if (!cell.startsWith("J") && cell !== `B${LIST_FIRST_DATA_ROW}`) continue;
    await client.writeValues(a1(LIST_TAB, cell), [[formula]], "USER_ENTERED");
  }

  log(options.quiet, "\nPlanilha preparada. Nenhuma linha de dados foi apagada.");
}

main().catch((error: unknown) => {
  // Erro do Google sai como código curto; qualquer outro sai sem detalhe, para
  // não imprimir credencial nem conteúdo de célula no terminal.
  const code = error instanceof GoogleSheetsError ? error.code : "UNEXPECTED_ERROR";
  console.error(`Falha no setup da planilha: ${code}`);
  process.exitCode = 1;
});
