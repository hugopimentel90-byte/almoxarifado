/**
 * Web App do Google Apps Script para receber lançamentos do Dashboard Almoxarifado
 * e gravar nas abas "Registro" (retiradas) e "Estoque" (entradas de material).
 *
 * Mapeamento de colunas na aba "Registro" (retiradas):
 *   A - Nome do produto
 *   B - Quantidade
 *   C - Tipo de unidade
 *   D - Data de lançamento
 *   E - Setor
 *   F - Número do pedido
 *   G - (não utilizado por este formulário)
 *   H - Pago em
 *   I - Mês do lançamento
 *   J - Categoria
 *   L - Tempo de retirada em minutos (cronômetro ou preenchimento manual no
 *       app), gravado apenas na PRIMEIRA linha do lote de itens de cada
 *       retirada enviada (as demais linhas do mesmo pedido ficam em branco)
 *
 * Mapeamento na aba "Estoque" (entradas de material e consulta de níveis):
 *   A - Nome do produto (lista mestre; se o produto ainda não existir, uma nova
 *       linha é criada automaticamente ao final da coluna)
 *   B - Tipo de unidade
 *   C - Quantidade base/inicial em estoque
 *   D - Categoria (Produto de limpeza, Escritório, Industrial, Prefeitura),
 *       preenchida apenas quando o material é cadastrado como novo pelo
 *       formulário de Entrada
 *   E - não utilizada por este formulário
 *   F em diante - cada entrada é gravada na primeira coluna vazia A PARTIR DE F
 *       NAQUELA LINHA especificamente (análise individual por produto, sem
 *       considerar o que outras linhas já têm preenchido nas mesmas colunas)
 *
 *   O nível de estoque de cada produto (consultado via GET ?action=estoque) é:
 *     coluna C + soma das colunas de entrada (F em diante)
 *
 *   Esse valor já reflete as retiradas: toda vez que uma retirada é enviada,
 *   o script primeiro verifica se há saldo suficiente (C + entradas) e, se
 *   houver, desconta a quantidade retirada diretamente das células — primeiro
 *   da coluna C, e se não for suficiente, das colunas de entrada (F em diante,
 *   da mais antiga para a mais nova). Se o saldo não for suficiente, a retirada
 *   inteira é rejeitada (nada é gravado) e o app mostra um aviso ao usuário.
 *
 * COMO INSTALAR:
 * 1. Abra a planilha do Google Sheets.
 * 2. Menu Extensões > Apps Script.
 * 3. Apague o conteúdo do arquivo Code.gs (se houver) e cole este código.
 * 4. Salve (ícone de disquete).
 * 5. Clique em "Implantar" > "Gerenciar implantações".
 *    - Se já existe uma implantação (a URL usada em SCRIPT_URL no app.js),
 *      clique no lápis (editar) > em "Versão" escolha "Nova versão" > Implantar.
 *    - Se não existe nenhuma, clique em "Nova implantação" > tipo "App da Web":
 *        Executar como: Eu (seu e-mail)
 *        Quem pode acessar: Qualquer pessoa
 *      Copie a URL gerada e cole em SCRIPT_URL no app.js.
 * 6. Na primeira execução, o Google vai pedir autorização de permissões — aceite.
 */

const REGISTRO_SHEET_NAME = "Registro";
const ESTOQUE_SHEET_NAME = "Estoque";
const ESTOQUE_START_COLUMN = 6; // coluna F

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("Nenhum dado recebido na requisição.");
    }

    const payload = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    let tipo = "retirada";
    let items = payload;

    if (payload && !Array.isArray(payload) && Array.isArray(payload.items)) {
      tipo = payload.tipo || "retirada";
      items = payload.items;
    }
    if (!Array.isArray(items)) {
      items = [items];
    }

    const count = (tipo === "entrada")
      ? handleEntradaMaterial(ss, items)
      : handleRetiradaMaterial(ss, items);

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success", count: count }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const response = { status: "error", message: err.message };
    if (err.name === "EstoqueInsuficienteError" && err.details) {
      response.type = "estoque_insuficiente";
      response.details = err.details;
    }
    return ContentService
      .createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Grava retiradas na aba "Registro" e desconta o estoque correspondente na
 * aba "Estoque". Antes de gravar qualquer coisa, valida se há saldo
 * suficiente para TODOS os itens da retirada; se algum produto não tiver
 * saldo suficiente, nada é gravado e um erro tipado é lançado.
 */
function handleRetiradaMaterial(ss, items) {
  const registroSheet = ss.getSheetByName(REGISTRO_SHEET_NAME);
  if (!registroSheet) {
    throw new Error('Aba "' + REGISTRO_SHEET_NAME + '" não encontrada na planilha.');
  }

  const estoqueSheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    // 1. Agrega a quantidade solicitada por produto e verifica o saldo disponível.
    //    Produtos que ainda não existem na aba "Estoque" não são validados
    //    (não há como saber o saldo deles).
    const stockByProduct = {};

    if (estoqueSheet) {
      items.forEach(function (item) {
        const productName = (item.produto || "").trim();
        if (!productName) return;

        const key = productName.toLowerCase();
        if (!(key in stockByProduct)) {
          const row = findRowByProductName(estoqueSheet, 1, productName);
          stockByProduct[key] = (row === -1) ? null : buildStockInfo(estoqueSheet, row, productName);
        }

        if (stockByProduct[key]) {
          stockByProduct[key].requested += Number(item.qtd) || 0;
        }
      });
    }

    const insufficient = Object.keys(stockByProduct)
      .map(function (key) { return stockByProduct[key]; })
      .filter(function (info) { return info && info.requested > info.available; })
      .map(function (info) {
        return { produto: info.produto, disponivel: info.available, solicitado: info.requested };
      });

    if (insufficient.length > 0) {
      const err = new Error("Quantidade solicitada excede o estoque disponível para: " +
        insufficient.map(function (d) {
          return d.produto + " (disponível: " + d.disponivel + ", solicitado: " + d.solicitado + ")";
        }).join("; "));
      err.name = "EstoqueInsuficienteError";
      err.details = insufficient;
      throw err;
    }

    // 2. Grava as retiradas na aba "Registro".
    let lastRow = getLastRowInColumn(registroSheet, 1);

    items.forEach(function (item) {
      lastRow++;
      const row = [
        item.produto || "",                    // A - Nome do produto
        item.qtd != null ? item.qtd : "",       // B - Quantidade
        item.un || "",                          // C - Tipo de unidade
        item.dataStr || item.data || "",        // D - Data de lançamento
        item.setor || "",                       // E - Setor
        item.pedido || "",                      // F - Número do pedido
        "",                                     // G - não utilizado
        item.pagoEm || "",                      // H - Pago em
        item.mes || "",                         // I - Mês do lançamento
        item.categoria || ""                    // J - Categoria
      ];
      registroSheet.getRange(lastRow, 1, 1, row.length).setValues([row]);

      if (item.tempoRetiradaMinutos !== undefined && item.tempoRetiradaMinutos !== null && item.tempoRetiradaMinutos !== "") {
        registroSheet.getRange(lastRow, 12).setValue(item.tempoRetiradaMinutos); // L - Tempo de retirada (minutos)
      }
    });

    // 3. Desconta fisicamente o estoque: primeiro da coluna C, depois das
    //    colunas de entrada (F em diante, da mais antiga para a mais nova).
    Object.keys(stockByProduct).forEach(function (key) {
      const info = stockByProduct[key];
      if (info && info.requested > 0) {
        decrementEstoqueStock(estoqueSheet, info.row, info.requested);
      }
    });

    return items.length;

  } finally {
    lock.releaseLock();
  }
}

/**
 * Lê o saldo atual (coluna C + colunas de entrada) de um produto na aba
 * "Estoque" para a linha informada.
 */
function buildStockInfo(sheet, row, productName) {
  const lastColumn = sheet.getLastColumn();
  const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

  const baseValue = Number(sheet.getRange(row, 3).getValue()) || 0;
  const entradaValues = entradaColumnCount > 0
    ? sheet.getRange(row, ESTOQUE_START_COLUMN, 1, entradaColumnCount).getValues()[0]
    : [];

  const entradasSum = entradaValues.reduce(function (sum, v) { return sum + (Number(v) || 0); }, 0);

  return {
    produto: productName,
    row: row,
    available: baseValue + entradasSum,
    requested: 0
  };
}

/**
 * Desconta qtyToRemove do saldo de um produto: primeiro da coluna C, e se
 * não for suficiente, das colunas de entrada (F em diante, da mais antiga
 * para a mais nova) até zerar a quantidade a remover.
 */
function decrementEstoqueStock(sheet, row, qtyToRemove) {
  let remaining = qtyToRemove;
  if (remaining <= 0) return;

  const baseCell = sheet.getRange(row, 3);
  const baseValue = Number(baseCell.getValue()) || 0;
  const deductFromBase = Math.min(baseValue, remaining);
  if (deductFromBase > 0) {
    baseCell.setValue(baseValue - deductFromBase);
    remaining -= deductFromBase;
  }

  if (remaining > 0) {
    const lastColumn = sheet.getLastColumn();
    const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

    for (let col = ESTOQUE_START_COLUMN; col < ESTOQUE_START_COLUMN + entradaColumnCount && remaining > 0; col++) {
      const cell = sheet.getRange(row, col);
      const value = Number(cell.getValue()) || 0;
      if (value <= 0) continue;

      const deduct = Math.min(value, remaining);
      cell.setValue(value - deduct);
      remaining -= deduct;
    }
  }
}

/**
 * Grava entradas de material na aba "Estoque". Para cada item, a coluna de
 * destino é decidida individualmente pela LINHA daquele produto: começa em F
 * e avança até achar a primeira célula vazia NAQUELA linha (independente do
 * que outras linhas/produtos já têm preenchido). Produtos que ainda não
 * existem na coluna A são adicionados automaticamente. Quando o item chega
 * com uma categoria (só acontece ao cadastrar um material novo pelo app),
 * ela é gravada na coluna D.
 */
function handleEntradaMaterial(ss, items) {
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    items.forEach(function (item) {
      const productName = (item.produto || "").trim();
      if (!productName) return;

      let row = findRowByProductName(sheet, 1, productName);
      if (row === -1) {
        row = getLastRowInColumn(sheet, 1) + 1;
        sheet.getRange(row, 1).setValue(productName);
      }

      sheet.getRange(row, 2).setValue(item.un || "");
      if (item.categoria) {
        sheet.getRange(row, 4).setValue(item.categoria);
      }

      const targetColumn = getNextEmptyColumnInRow(sheet, row, ESTOQUE_START_COLUMN);
      sheet.getRange(row, targetColumn).setValue(item.qtd != null ? item.qtd : "");
    });

    return items.length;

  } finally {
    lock.releaseLock();
  }
}

/**
 * Retorna o número da última linha com conteúdo em uma coluna específica
 * (1 = coluna A). Considera a linha 1 como cabeçalho.
 */
function getLastRowInColumn(sheet, column) {
  const numRows = sheet.getMaxRows();
  const values = sheet.getRange(1, column, numRows, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== "" && values[i][0] !== null) {
      return i + 1;
    }
  }
  return 1; // nenhuma linha de dados encontrada, assume apenas o cabeçalho
}

/**
 * Procura o nome de um produto (case-insensitive) em uma coluna específica,
 * a partir da linha 2. Retorna o número da linha ou -1 se não encontrado.
 */
function findRowByProductName(sheet, column, productName) {
  const lastRow = getLastRowInColumn(sheet, column);
  if (lastRow < 2) return -1;

  const values = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  const target = productName.trim().toLowerCase();

  for (let i = 0; i < values.length; i++) {
    const cell = String(values[i][0] || "").trim().toLowerCase();
    if (cell === target) {
      return i + 2;
    }
  }
  return -1;
}

/**
 * Retorna a primeira coluna, a partir de startColumn, que está vazia NA
 * LINHA informada — analisa só aquela linha, sem considerar o que outras
 * linhas/produtos têm preenchido nas mesmas colunas.
 */
function getNextEmptyColumnInRow(sheet, row, startColumn) {
  const lastColumn = Math.max(sheet.getLastColumn(), startColumn);
  const numColsToCheck = lastColumn - startColumn + 1;
  const values = sheet.getRange(row, startColumn, 1, numColsToCheck).getValues()[0];

  for (let i = 0; i < values.length; i++) {
    if (values[i] === "" || values[i] === null) {
      return startColumn + i;
    }
  }
  return startColumn + values.length;
}

/**
 * Atende requisições GET. Sem parâmetros, apenas confirma que o Web App está
 * no ar. Com ?action=estoque, retorna os níveis atuais de estoque calculados
 * a partir da aba "Estoque".
 */
function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === "estoque") {
      return getEstoqueLevels();
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", message: "Web App ativo." }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Calcula o nível de estoque de cada produto na aba "Estoque":
 * coluna C (quantidade base) + soma das colunas de entrada (F em diante).
 * As retiradas já são refletidas aqui, pois são descontadas diretamente das
 * células no momento em que acontecem (ver handleRetiradaMaterial). Também
 * devolve a categoria (coluna D), quando preenchida, para o app conseguir
 * classificar na Consulta de Estoque mesmo produtos sem histórico de retirada.
 */
function getEstoqueLevels() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');
  }

  const lastProductRow = getLastRowInColumn(sheet, 1);
  const items = [];

  if (lastProductRow >= 2) {
    const rowCount = lastProductRow - 1;
    const lastColumn = sheet.getLastColumn();
    const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

    const productNames = sheet.getRange(2, 1, rowCount, 1).getValues();
    const units = sheet.getRange(2, 2, rowCount, 1).getValues();
    const baseValues = sheet.getRange(2, 3, rowCount, 1).getValues();
    const categories = sheet.getRange(2, 4, rowCount, 1).getValues();
    const entradaValues = entradaColumnCount > 0
      ? sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, entradaColumnCount).getValues()
      : [];

    for (let i = 0; i < rowCount; i++) {
      const produto = String(productNames[i][0] || "").trim();
      if (!produto) continue;

      const un = String(units[i][0] || "").trim();
      const base = Number(baseValues[i][0]) || 0;
      const categoria = String(categories[i][0] || "").trim();

      let entradasSum = 0;
      for (let j = 0; j < entradaColumnCount; j++) {
        entradasSum += Number(entradaValues[i][j]) || 0;
      }

      items.push({
        produto: produto,
        un: un,
        categoria: categoria,
        total: base + entradasSum
      });
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: "success", items: items }))
    .setMimeType(ContentService.MimeType.JSON);
}
