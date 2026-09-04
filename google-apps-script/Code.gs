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
 *   E - Código de Barras do produto (preenchido manualmente na planilha).
 *       Usado pela leitura via leitor de código de barras na tela de Retirada
 *       para identificar automaticamente o produto correspondente.
 *   F - Ponto de Pedido: quantidade mínima abaixo da qual o comprador deve
 *       disparar um novo pedido de compra. Preenchido manualmente na
 *       planilha (não é editável pelo app). Usado pela página "Ponto de
 *       Pedido" (acesso restrito ao perfil administrador) para sinalizar o
 *       status de cada produto: vermelho quando o estoque já está no ponto
 *       de pedido ou abaixo, amarelo quando está até 30% acima dele, e
 *       verde quando está confortavelmente acima.
 *   G - total corrente de entradas: cada envio do formulário de Entrada SOMA
 *       a quantidade aqui (não abre mais uma coluna nova a cada entrada —
 *       isso mantém a aba com largura fixa para sempre, independente de há
 *       quantos anos o Almoxarifado esteja em uso)
 *
 *   O nível de estoque de cada produto (consultado via GET ?action=estoque) é:
 *     coluna C + coluna G
 *
 *   Esse valor já reflete as retiradas: toda vez que uma retirada é enviada,
 *   o script primeiro verifica se há saldo suficiente (C + G) e, se houver,
 *   desconta a quantidade retirada diretamente das células — primeiro da
 *   coluna C, e se não for suficiente, da coluna G. Se o saldo não for
 *   suficiente, a retirada inteira é rejeitada (nada é gravado) e o app
 *   mostra um aviso ao usuário.
 *
 * Aba "Liberacao" (Kanban de Liberação de Documentos) — criada automaticamente
 * pelo script na primeira vez que for usada, com as colunas:
 *   A - ID do card
 *   B - Setor
 *   C - Título
 *   D - Descrição
 *   E - Nome do arquivo anexado
 *   F - URL do arquivo no Google Drive
 *   G - Status atual (Setor | Encarregado | Imediato | Liberados)
 *   H - Criado em
 *   I - Transmitido em (Setor -> Encarregado)
 *   J - Aprovado pelo Encarregado em
 *   K - Aprovado pelo Imediato em (= liberado em)
 *   L - Última ação (ex: registro de uma recusa)
 *   M - Itens (JSON): lista [{produto, qtd}, ...] extraída automaticamente
 *       do PDF no momento do upload (heurística: qualquer linha do PDF que
 *       termine em número é tratada como um item de tabela). Editável pelo
 *       Encarregado (aumentar/diminuir quantidade, excluir item) — a versão
 *       revisada substitui esta coluna ao aprovar; o Imediato só visualiza.
 *
 *   O documento anexado é salvo no Google Drive (pasta "Almoxarifado -
 *   Documentos de Liberação"), compartilhado como "qualquer pessoa com o
 *   link pode visualizar". A aprovação do Encarregado e do Imediato exige
 *   senha; a etapa de "Transmitir" (Setor -> Encarregado) e a recusa não.
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
const ESTOQUE_START_COLUMN = 7; // coluna G
const ESTOQUE_BARCODE_COLUMN = 5; // coluna E
const ESTOQUE_REORDER_POINT_COLUMN = 6; // coluna F

const LIBERACAO_SHEET_NAME = "Liberacao";
const LIBERACAO_DRIVE_FOLDER_NAME = "Almoxarifado - Documentos de Liberação";
const LIBERACAO_ENCARREGADO_PASSWORD = "encarregado321";
const LIBERACAO_IMEDIATO_PASSWORD = "imediato321";

/**
 * Aba "Demanda" — dados de fornecimento usados para montar o Pedido de
 * Obtenção quando um produto atinge o Ponto de Pedido. Colunas:
 *   A - Material (nome do produto, casado com o nome usado na aba "Estoque")
 *   B - Ponto de Pedido (referência; o valor realmente usado pelo app pra
 *       calcular o status continua sendo o da aba "Estoque", coluna F)
 *   C - Unidade (UF do Pedido de Obtenção)
 *   D - Categoria
 *   E - Descrição do Fornecedor (texto longo que vai na coluna DESCRIÇÃO do PDF)
 *   F - Quantidade mínima
 *   G - Multiplicador (QTD do PDF = F × G)
 *   H - Valor unitário (VALOR (UN) do PDF; TOTAL do PDF = QTD × H)
 */
const DEMANDA_SHEET_NAME = "Demanda";

/**
 * Cache compartilhado por TODAS as execuções do script (não é por usuário) —
 * usado para evitar reler a planilha inteira toda vez que alguém troca de
 * aba no site. Com vários usuários acessando ao mesmo tempo, cada um
 * disparava sua própria leitura completa da aba, competindo pelo mesmo
 * recurso e deixando tudo mais lento pra todo mundo; com o cache "quente",
 * a mesma consulta feita por qualquer usuário nos próximos segundos é
 * respondida na hora, sem tocar na planilha de novo.
 *
 * O tempo de vida é curto (poucos segundos) de propósito: é só o suficiente
 * pra absorver várias trocas de aba/atualizações simultâneas, sem deixar o
 * app mostrando dado desatualizado por muito tempo depois de uma gravação.
 */
const CACHE_TTL_SECONDS = 20;
const CACHE_KEY_ESTOQUE = 'estoque_levels';
const CACHE_KEY_DEMANDA = 'demanda_data';
const CACHE_KEY_LIBERACAO = 'liberacao_cards';

/**
 * SÓ PRECISA RODAR UMA VEZ, MANUALMENTE, PELO EDITOR DO APPS SCRIPT.
 * Selecione esta função no menu suspenso ao lado do botão "Executar" (▶) e
 * clique em Executar. Isso abre a tela de autorização e concede ao script a
 * permissão de acessar o Google Drive, necessária para o upload de
 * documentos da aba "Liberação". Sem rodar isso uma vez, chamadas feitas de
 * fora (pelo site) falham com erro de permissão, pois o Apps Script não
 * consegue abrir a tela de autorização sozinho quando é chamado via HTTP.
 *
 * Importante: esta função exercita as MESMAS operações de leitura E escrita
 * que o app realmente usa (criar pasta, criar arquivo, compartilhar, apagar),
 * pra garantir que a tela de autorização peça o escopo completo do Drive
 * (não só leitura).
 */
function autorizarAcessoAoDrive() {
  const folder = getOrCreateLiberacaoFolder();
  const testBlob = Utilities.newBlob("teste de autorização", "text/plain", "teste-autorizacao.txt");
  const testFile = folder.createFile(testBlob);
  testFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  testFile.setTrashed(true);
}

/**
 * SÓ PRECISA RODAR UMA VEZ, MANUALMENTE, PELO EDITOR DO APPS SCRIPT.
 * Concede ao script a permissão de enviar e-mails (necessária para o botão
 * "Enviar por E-mail" do Pedido de Obtenção na página de Ponto de Pedido).
 * Sem rodar isso uma vez, chamadas feitas de fora (pelo site) falham com
 * erro de permissão. Envia um e-mail de teste para a própria conta que
 * publicou o Web App, só para confirmar que a autorização foi concedida.
 */
function autorizarEnvioDeEmail() {
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: "Teste de autorização — Dashboard Almoxarifado",
    body: "Este e-mail confirma que o Web App tem permissão para enviar e-mails com anexo."
  });
}

/**
 * FERRAMENTA DE LIMPEZA — RODAR MANUALMENTE, UMA VEZ, PELO EDITOR DO APPS SCRIPT.
 *
 * A aba "Estoque" acumulou muitas linhas duplicadas (o mesmo produto
 * cadastrado várias vezes ao longo do tempo). Esta função NÃO altera nada —
 * ela só lê a aba e mostra, no log (menu "Execução" > "Registros de
 * execução", ou Ctrl+Enter depois de rodar), quais produtos têm linhas
 * duplicadas e como ficariam se fossem consolidados numa única linha por
 * produto. Rode esta função PRIMEIRO, revise o log com calma, e só depois
 * rode consolidarProdutosDuplicadosEstoque() (logo abaixo) se o resultado
 * fizer sentido.
 */
function preverConsolidacaoEstoque() {
  const resultado = agruparDuplicatasEstoque_();
  const duplicados = resultado.grupos.filter(function (g) { return g.linhas.length > 1; });

  Logger.log('=== PRÉVIA DE CONSOLIDAÇÃO — NADA FOI ALTERADO NA PLANILHA ===');
  Logger.log('Total de linhas de produto na aba: ' + resultado.totalLinhas);
  Logger.log('Produtos únicos (nome, ignorando maiúsculas/minúsculas e espaços): ' + resultado.grupos.length);
  Logger.log('Produtos com linhas duplicadas: ' + duplicados.length);
  Logger.log('Linhas que seriam removidas no total: ' + resultado.totalLinhasRemovidas);
  Logger.log('');

  duplicados.forEach(function (g) {
    const linhasStr = g.linhas.map(function (l) { return l.row; }).join(', ');
    Logger.log(
      '"' + g.produto + '" — ' + g.linhas.length + ' linhas (linhas ' + linhasStr + ') → ' +
      '1 linha (a de número ' + g.linhas[0].row + ') com quantidade base = ' + g.novaBase +
      ' e total de entradas = ' + g.entradaTotal
    );
  });
}

/**
 * FERRAMENTA DE LIMPEZA — RODAR MANUALMENTE, UMA VEZ, PELO EDITOR DO APPS
 * SCRIPT, DEPOIS DE REVISAR O LOG DE preverConsolidacaoEstoque().
 *
 * Consolida as linhas duplicadas da aba "Estoque" (mesmo nome de produto,
 * ignorando maiúsculas/minúsculas e espaços nas pontas): reconstrói a área
 * de dados da aba (linha 2 em diante) com UMA linha por produto — soma a
 * quantidade base (coluna C) e o total de entradas (coluna G) de todas as
 * duplicatas, e aproveita a primeira unidade/categoria/código de barras não
 * vazios encontrados entre elas.
 *
 * Faz isso com POUCAS operações em lote (uma leitura, uma escrita, uma
 * limpeza) em vez de uma operação por célula/linha, e escreve sempre
 * exatamente UMA coluna de entrada (G) por produto — nunca uma por
 * duplicata — pra aba nunca ficar larga demais (ver handleEntradaMaterial).
 *
 * ⚠️ Isso reescreve a aba inteira — é uma operação que não pode ser
 * desfeita com Ctrl+Z depois de fechar a aba. Faça uma cópia da aba
 * "Estoque" (clique direito na aba > Duplicar) antes de rodar esta função.
 */
function consolidarProdutosDuplicadosEstoque() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');

  const resultado = agruparDuplicatasEstoque_();
  const grupos = resultado.grupos;
  const totalLinhasAntigas = resultado.totalLinhas;
  const totalColunas = ESTOQUE_START_COLUMN; // A..F fixas + G (única coluna de entrada)

  // Monta em memória a matriz completa (uma linha por produto único).
  const novaMatriz = grupos.map(function (g) {
    const linha = new Array(totalColunas).fill('');
    linha[0] = g.produto;                                  // A
    linha[1] = g.un || '';                                 // B
    linha[2] = g.novaBase;                                 // C
    linha[3] = g.categoria || '';                           // D
    linha[ESTOQUE_BARCODE_COLUMN - 1] = g.codigoBarras || ''; // E
    linha[ESTOQUE_REORDER_POINT_COLUMN - 1] = g.pontoPedido || ''; // F
    linha[ESTOQUE_START_COLUMN - 1] = g.entradaTotal;        // G
    return linha;
  });

  // Escreve tudo de uma vez (uma única chamada, em vez de célula por célula).
  if (novaMatriz.length > 0) {
    sheet.getRange(2, 1, novaMatriz.length, totalColunas).setValues(novaMatriz);
  }

  // Limpa o que sobrou das linhas E colunas antigas (a nova área é mais
  // curta/estreita que a antiga), também em poucas chamadas.
  const linhasSobrando = totalLinhasAntigas - novaMatriz.length;
  if (linhasSobrando > 0) {
    const primeiraLinhaSobrando = 2 + novaMatriz.length;
    const colunasParaLimpar = Math.max(sheet.getLastColumn(), totalColunas);
    sheet.getRange(primeiraLinhaSobrando, 1, linhasSobrando, colunasParaLimpar).clearContent();
  }
  const colunasSobrando = sheet.getLastColumn() - totalColunas;
  if (colunasSobrando > 0 && novaMatriz.length > 0) {
    sheet.getRange(2, totalColunas + 1, novaMatriz.length, colunasSobrando).clearContent();
  }

  Logger.log(
    'Consolidação concluída. Produtos únicos: ' + novaMatriz.length +
    ' (antes: ' + totalLinhasAntigas + ' linhas). Linhas duplicadas removidas: ' + linhasSobrando
  );
  invalidateEstoqueCache_();
}

/**
 * FERRAMENTA DE REPARO — RODAR MANUALMENTE, UMA VEZ, PELO EDITOR DO APPS SCRIPT.
 *
 * Reduz as colunas de entrada de cada produto (G em diante) a uma ÚNICA
 * coluna (G) com a soma de tudo que havia ali. Não perde nenhuma
 * quantidade — só para de guardar o histórico transação-por-transação em
 * dezenas/centenas de colunas (histórico que o app nunca chegou a exibir
 * em lugar nenhum de qualquer forma).
 *
 * Rode esta função se a aba "Estoque" já ficou larga demais — por exemplo,
 * depois de ter rodado uma versão anterior de consolidarProdutosDuplicadosEstoque()
 * que ainda concatenava o histórico de entradas em várias colunas em vez de
 * somar tudo numa só (foi exatamente essa largura excessiva que deixou as
 * consultas de Estoque e Retirada muito lentas mesmo depois de reduzir o
 * número de linhas duplicadas).
 */
function compactarEntradasEstoque() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

  if (lastRow < 2 || entradaColumnCount <= 1) {
    Logger.log('Nada para compactar: a aba já tem no máximo 1 coluna de entrada.');
    return;
  }

  const rowCount = lastRow - 1;
  const entradaValues = sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, entradaColumnCount).getValues();

  const somaPorLinha = entradaValues.map(function (linha) {
    const soma = linha.reduce(function (acc, v) { return acc + (Number(v) || 0); }, 0);
    return [soma];
  });

  // Limpa TODAS as colunas de entrada antigas de uma vez, depois escreve só o total, numa única coluna (G).
  sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, entradaColumnCount).clearContent();
  sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, 1).setValues(somaPorLinha);

  Logger.log(
    'Compactação concluída. Colunas de entrada: ' + entradaColumnCount + ' → 1. Linhas processadas: ' + rowCount
  );
  invalidateEstoqueCache_();
}

/**
 * Função auxiliar compartilhada pelas ferramentas de limpeza acima: lê a
 * aba "Estoque" e agrupa as linhas por nome de produto (normalizado).
 */
function agruparDuplicatasEstoque_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');

  const lastProductRow = getLastRowInColumn(sheet, 1);
  const gruposPorChave = {};
  const ordem = [];

  if (lastProductRow >= 2) {
    const rowCount = lastProductRow - 1;
    const lastColumn = sheet.getLastColumn();
    const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

    const productNames = sheet.getRange(2, 1, rowCount, 1).getValues();
    const units = sheet.getRange(2, 2, rowCount, 1).getValues();
    const baseValues = sheet.getRange(2, 3, rowCount, 1).getValues();
    const categories = sheet.getRange(2, 4, rowCount, 1).getValues();
    const barcodes = sheet.getRange(2, ESTOQUE_BARCODE_COLUMN, rowCount, 1).getValues();
    const reorderPoints = sheet.getRange(2, ESTOQUE_REORDER_POINT_COLUMN, rowCount, 1).getValues();
    const entradaValues = entradaColumnCount > 0
      ? sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, entradaColumnCount).getValues()
      : [];

    for (let i = 0; i < rowCount; i++) {
      const produto = String(productNames[i][0] || '').trim();
      if (!produto) continue;

      const rowNumber = i + 2;
      const un = String(units[i][0] || '').trim();
      const base = Number(baseValues[i][0]) || 0;
      const categoria = String(categories[i][0] || '').trim();
      const codigoBarras = String(barcodes[i][0] || '').trim();
      const pontoPedido = Number(reorderPoints[i][0]) || 0;

      let entradaSomaDaLinha = 0;
      for (let j = 0; j < entradaColumnCount; j++) {
        entradaSomaDaLinha += Number(entradaValues[i][j]) || 0;
      }

      const key = produto.toLowerCase();
      if (!gruposPorChave[key]) {
        gruposPorChave[key] = {
          produto: produto,
          un: '',
          categoria: '',
          codigoBarras: '',
          pontoPedido: 0,
          novaBase: 0,
          entradaTotal: 0,
          linhas: []
        };
        ordem.push(key);
      }

      const g = gruposPorChave[key];
      g.novaBase += base;
      g.entradaTotal += entradaSomaDaLinha;
      if (!g.un && un) g.un = un;
      if (!g.categoria && categoria) g.categoria = categoria;
      if (!g.codigoBarras && codigoBarras) g.codigoBarras = codigoBarras;
      if (!g.pontoPedido && pontoPedido) g.pontoPedido = pontoPedido;
      g.linhas.push({ row: rowNumber });
    }
  }

  const grupos = ordem.map(function (key) { return gruposPorChave[key]; });
  const totalLinhasRemovidas = grupos.reduce(function (sum, g) { return sum + Math.max(g.linhas.length - 1, 0); }, 0);

  return {
    totalLinhas: lastProductRow >= 2 ? lastProductRow - 1 : 0,
    grupos: grupos,
    totalLinhasRemovidas: totalLinhasRemovidas
  };
}

/**
 * Devolve a resposta pronta (JSON) de uma consulta a partir do cache, se
 * houver uma versão recente guardada; senão, calcula na hora chamando
 * computeJsonFn(), guarda o resultado no cache (quando cabe) e devolve.
 */
function getFromCacheOrCompute_(cacheKey, computeJsonFn) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  }

  const json = computeJsonFn();
  try {
    cache.put(cacheKey, json, CACHE_TTL_SECONDS);
  } catch (err) {
    // O CacheService recusa guardar valores acima de ~100KB. Se a aba tiver
    // ficado grande demais pro cache, simplesmente não guarda — a próxima
    // consulta volta a buscar direto da planilha, sem quebrar nada.
  }

  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Descarta o cache de níveis de estoque. Chamada sempre que uma Entrada ou
 * Retirada é gravada (e pelas ferramentas manuais de consolidação/limpeza
 * da aba Estoque), pra garantir que a próxima consulta já reflita a
 * gravação — em vez de mostrar dado desatualizado até o cache expirar
 * sozinho.
 */
function invalidateEstoqueCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY_ESTOQUE);
}

/**
 * Descarta o cache dos cards de Liberação. Chamada sempre que um card é
 * criado, avança, é recusado ou excluído.
 */
function invalidateLiberacaoCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY_LIBERACAO);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("Nenhum dado recebido na requisição.");
    }

    const payload = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tipo = (payload && payload.tipo) || "retirada";

    let response;
    if (tipo === "entrada") {
      response = { count: handleEntradaMaterial(ss, normalizeItemsPayload(payload)) };
    } else if (tipo === "liberacao_criar") {
      response = { card: handleLiberacaoCriar(ss, payload) };
    } else if (tipo === "liberacao_avancar") {
      response = { card: handleLiberacaoAvancar(ss, payload) };
    } else if (tipo === "liberacao_recusar") {
      response = { card: handleLiberacaoRecusar(ss, payload) };
    } else if (tipo === "liberacao_excluir") {
      response = { deleted: handleLiberacaoExcluir(ss, payload) };
    } else if (tipo === "enviar_pedido_obtencao") {
      response = { enviado: handleEnviarPedidoObtencao(payload) };
    } else {
      response = { count: handleRetiradaMaterial(ss, normalizeItemsPayload(payload)) };
    }

    response.status = "success";
    return ContentService
      .createTextOutput(JSON.stringify(response))
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
 * Normaliza o payload de retirada/entrada, que pode chegar como um array
 * puro de itens (formato antigo) ou como { tipo, items: [...] }.
 */
function normalizeItemsPayload(payload) {
  let items = payload;
  if (payload && !Array.isArray(payload) && Array.isArray(payload.items)) {
    items = payload.items;
  }
  if (!Array.isArray(items)) {
    items = [items];
  }
  return items;
}

/**
 * Grava retiradas na aba "Registro" e desconta o estoque correspondente na
 * aba "Estoque". Antes de gravar qualquer coisa, valida se há saldo
 * suficiente para TODOS os itens da retirada; se algum produto não tiver
 * saldo suficiente, nada é gravado e um erro tipado é lançado.
 *
 * Toda a leitura da aba "Estoque" acontece de uma vez só, no início (ver
 * lerEstoqueParaRetirada_), e todas as gravações são feitas em lote (uma
 * chamada para a aba "Registro" com todos os itens, e uma chamada por
 * produto afetado no "Estoque") — em vez de uma chamada de leitura/escrita
 * por produto/coluna, como era feito antes. Isso importa porque tudo isso
 * acontece com o lock do script preso: quanto menos chamadas à planilha
 * dentro do lock, menos tempo outra pessoa usando o app (Retirada, Entrada
 * ou Liberação) fica esperando na fila para poder gravar a dela.
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
    // 1. Lê a aba "Estoque" inteira de uma vez (nomes, base, categoria,
    //    código de barras, ponto de pedido e colunas de entrada), e monta
    //    um índice por nome de produto — nenhuma leitura adicional é feita
    //    por produto do lote a partir daqui.
    const estoqueSnapshot = estoqueSheet ? lerEstoqueParaRetirada_(estoqueSheet) : null;

    // 2. Agrega a quantidade solicitada por produto e verifica o saldo
    //    disponível, tudo calculado em memória a partir do snapshot acima.
    //    Produtos que ainda não existem na aba "Estoque" não são validados
    //    (não há como saber o saldo deles).
    const stockByProduct = {};

    if (estoqueSnapshot) {
      items.forEach(function (item) {
        const productName = (item.produto || "").trim();
        if (!productName) return;

        const key = productName.toLowerCase();
        if (!(key in stockByProduct)) {
          const info = estoqueSnapshot.porNome[key];
          stockByProduct[key] = info
            ? {
                produto: productName,
                row: info.row,
                base: info.base,
                entradaColunas: info.entradaColunas.slice(),
                categoria: info.categoria,
                codigoBarras: info.codigoBarras,
                pontoPedido: info.pontoPedido,
                requested: 0
              }
            : null;
        }

        if (stockByProduct[key]) {
          stockByProduct[key].requested += Number(item.qtd) || 0;
        }
      });
    }

    const insufficient = Object.keys(stockByProduct)
      .map(function (key) { return stockByProduct[key]; })
      .filter(function (info) {
        if (!info) return false;
        const disponivel = info.base + info.entradaColunas.reduce(function (s, v) { return s + v; }, 0);
        return info.requested > disponivel;
      })
      .map(function (info) {
        const disponivel = info.base + info.entradaColunas.reduce(function (s, v) { return s + v; }, 0);
        return { produto: info.produto, disponivel: disponivel, solicitado: info.requested };
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

    // 3. Grava todas as retiradas na aba "Registro" em UMA única chamada
    //    (antes: uma chamada de escrita por item do lote).
    const lastRow = getLastRowInColumn(registroSheet, 1);
    const matrizRegistro = items.map(function (item) {
      return [
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
    });
    registroSheet.getRange(lastRow + 1, 1, matrizRegistro.length, 10).setValues(matrizRegistro);

    items.forEach(function (item, index) {
      if (item.tempoRetiradaMinutos !== undefined && item.tempoRetiradaMinutos !== null && item.tempoRetiradaMinutos !== "") {
        registroSheet.getRange(lastRow + 1 + index, 12).setValue(item.tempoRetiradaMinutos); // L - Tempo de retirada (minutos)
      }
    });

    // 4. Desconta fisicamente o estoque: primeiro da coluna C, depois das
    //    colunas de entrada (G em diante, da mais antiga para a mais nova).
    //    Os novos valores são calculados em memória e gravados com UMA
    //    única chamada por produto afetado (colunas C até a última coluna
    //    de entrada), em vez de uma chamada de leitura + escrita por coluna.
    if (estoqueSheet) {
      Object.keys(stockByProduct).forEach(function (key) {
        const info = stockByProduct[key];
        if (!info || info.requested <= 0) return;

        let remaining = info.requested;
        let novaBase = info.base;
        const deductBase = Math.min(novaBase, remaining);
        novaBase -= deductBase;
        remaining -= deductBase;

        const novasEntradas = info.entradaColunas.slice();
        for (let i = 0; i < novasEntradas.length && remaining > 0; i++) {
          const deduct = Math.min(novasEntradas[i], remaining);
          novasEntradas[i] -= deduct;
          remaining -= deduct;
        }

        const linhaValores = [novaBase, info.categoria, info.codigoBarras, info.pontoPedido].concat(novasEntradas);
        estoqueSheet.getRange(info.row, 3, 1, linhaValores.length).setValues([linhaValores]);
      });
    }

    return items.length;

  } finally {
    lock.releaseLock();
    invalidateEstoqueCache_();
  }
}

/**
 * Lê a aba "Estoque" inteira de uma só vez (nomes, base, categoria, código
 * de barras, ponto de pedido e todas as colunas de entrada) e monta um
 * índice por nome de produto. Usada por handleRetiradaMaterial para evitar
 * uma leitura separada da planilha para cada produto do lote — o tempo que
 * a operação prende o lock deixa de crescer com o número de produtos da
 * retirada.
 */
function lerEstoqueParaRetirada_(sheet) {
  const lastProductRow = getLastRowInColumn(sheet, 1);
  const porNome = {};
  if (lastProductRow < 2) {
    return { porNome: porNome };
  }

  const rowCount = lastProductRow - 1;
  const lastColumn = sheet.getLastColumn();
  const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

  const productNames = sheet.getRange(2, 1, rowCount, 1).getValues();
  const baseValues = sheet.getRange(2, 3, rowCount, 1).getValues();
  const categories = sheet.getRange(2, 4, rowCount, 1).getValues();
  const barcodes = sheet.getRange(2, ESTOQUE_BARCODE_COLUMN, rowCount, 1).getValues();
  const reorderPoints = sheet.getRange(2, ESTOQUE_REORDER_POINT_COLUMN, rowCount, 1).getValues();
  const entradaValues = entradaColumnCount > 0
    ? sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, entradaColumnCount).getValues()
    : [];

  for (let i = 0; i < rowCount; i++) {
    const produto = String(productNames[i][0] || "").trim();
    if (!produto) continue;

    const key = produto.toLowerCase();
    // Se houver linhas duplicadas do mesmo produto (planilha ainda não
    // consolidada), fica com a primeira encontrada — mesmo comportamento de
    // antes, que também só operava sobre a primeira linha localizada.
    if (porNome[key]) continue;

    porNome[key] = {
      row: i + 2,
      base: Number(baseValues[i][0]) || 0,
      entradaColunas: entradaColumnCount > 0 ? entradaValues[i].map(function (v) { return Number(v) || 0; }) : [],
      categoria: categories[i][0],
      codigoBarras: barcodes[i][0],
      pontoPedido: reorderPoints[i][0]
    };
  }

  return { porNome: porNome };
}

/**
 * Grava entradas de material na aba "Estoque". Para cada item, a quantidade
 * é SOMADA a um único total corrente na coluna G daquele produto — não é
 * mais criada uma coluna nova a cada entrada registrada. Produtos que ainda
 * não existem na coluna A são adicionados automaticamente. Quando o item
 * chega com uma categoria (só acontece ao cadastrar um material novo pelo
 * app), ela é gravada na coluna D.
 *
 * Antes, cada entrada abria uma coluna nova (G, H, I...) na linha do
 * produto — depois de anos de uso (e mais ainda depois de consolidar linhas
 * duplicadas, que juntava o histórico de várias linhas numa só), a aba
 * "Estoque" podia acabar com centenas de colunas de largura. Como a
 * planilha é uma grade retangular, isso deixava TODA consulta de estoque
 * lenta, não só a do produto com histórico extenso. Somar num único total
 * corrente mantém a aba com largura fixa (A até G) para sempre, não importa
 * há quantos anos o Almoxarifado esteja em uso.
 */
function handleEntradaMaterial(ss, items) {
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    // Lê a coluna A (nomes) e a coluna G (total de entradas) da aba inteira
    // UMA única vez, em vez de relançar uma busca na coluna inteira para
    // cada item do lote (como findRowByProductName fazia antes, por item).
    // Isso é o que mais importa aqui: com um lote de N itens, isso troca N
    // leituras completas da planilha por 2.
    const lastProductRow = getLastRowInColumn(sheet, 1);
    const rowCount = Math.max(lastProductRow - 1, 0);
    const nomesAtuais = rowCount > 0 ? sheet.getRange(2, 1, rowCount, 1).getValues() : [];
    const entradaAtual = rowCount > 0 ? sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, 1).getValues() : [];

    const rowByName = {};
    nomesAtuais.forEach(function (r, i) {
      const nome = String(r[0] || "").trim();
      if (nome) rowByName[nome.toLowerCase()] = i + 2;
    });

    const entradaAcumulada = {};   // linha -> novo total da coluna G
    const unidadePorLinha = {};    // linha -> última unidade informada no lote
    const categoriaPorLinha = {};  // linha -> categoria (só quando informada)
    const novosProdutos = {};      // linha -> nome do produto novo
    let proximaLinhaNova = lastProductRow + 1;

    items.forEach(function (item) {
      const productName = (item.produto || "").trim();
      if (!productName) return;

      const key = productName.toLowerCase();
      let row = rowByName[key];
      if (!row) {
        row = proximaLinhaNova++;
        rowByName[key] = row;
        novosProdutos[row] = productName;
      }

      unidadePorLinha[row] = item.un || "";
      if (item.categoria) {
        categoriaPorLinha[row] = item.categoria;
      }

      const totalAtual = entradaAcumulada[row] !== undefined
        ? entradaAcumulada[row]
        : (function () {
            const idx = row - 2;
            return (idx >= 0 && idx < entradaAtual.length) ? (Number(entradaAtual[idx][0]) || 0) : 0;
          })();
      const qtdNova = item.qtd != null ? Number(item.qtd) || 0 : 0;
      entradaAcumulada[row] = totalAtual + qtdNova;
    });

    // Grava: nome (só produtos novos), unidade, categoria (só se informada)
    // e o novo total de entradas — no máximo 2 chamadas por linha afetada.
    Object.keys(entradaAcumulada).forEach(function (rowStr) {
      const row = Number(rowStr);
      if (novosProdutos[row]) {
        sheet.getRange(row, 1).setValue(novosProdutos[row]);
      }
      sheet.getRange(row, 2).setValue(unidadePorLinha[row] || "");
      if (categoriaPorLinha[row]) {
        sheet.getRange(row, 4).setValue(categoriaPorLinha[row]);
      }
      sheet.getRange(row, ESTOQUE_START_COLUMN).setValue(entradaAcumulada[row]);
    });

    return items.length;

  } finally {
    lock.releaseLock();
    invalidateEstoqueCache_();
  }
}

/**
 * Retorna o número da última linha com conteúdo em uma coluna específica
 * (1 = coluna A). Considera a linha 1 como cabeçalho.
 *
 * Usa sheet.getLastRow() (a última linha com conteúdo em QUALQUER coluna da
 * aba) como limite superior da busca, em vez de sheet.getMaxRows() (o total
 * de linhas da aba, que costuma ser bem maior que os dados reais — ex.: 1000
 * linhas numa aba nova). Isso evita ler centenas de linhas vazias à toa
 * nessa função, que é chamada em toda gravação de Retirada/Entrada.
 */
function getLastRowInColumn(sheet, column) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return 1;

  const values = sheet.getRange(1, column, lastRow, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== "" && values[i][0] !== null) {
      return i + 1;
    }
  }
  return 1; // nenhuma linha de dados encontrada, assume apenas o cabeçalho
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
    if (e && e.parameter && e.parameter.action === "liberacao") {
      return getLiberacaoCards();
    }
    if (e && e.parameter && e.parameter.action === "demanda") {
      return getDemandaData();
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
 * coluna C (quantidade base) + soma das colunas de entrada (G em diante).
 * As retiradas já são refletidas aqui, pois são descontadas diretamente das
 * células no momento em que acontecem (ver handleRetiradaMaterial). Também
 * devolve a categoria (coluna D) e o código de barras (coluna E), quando
 * preenchidos, para o app conseguir classificar na Consulta de Estoque e
 * identificar produtos automaticamente na leitura por código de barras.
 *
 * A aba "Estoque" acumulou, ao longo do tempo, várias linhas duplicadas para
 * o mesmo produto (mesmo nome cadastrado mais de uma vez — em alguns casos,
 * dezenas de vezes). Se cada linha virasse um item separado na resposta, o
 * mesmo produto apareceria repetido várias vezes na Consulta de Estoque e no
 * seletor de produtos da Retirada, cada aparição mostrando só uma fração da
 * quantidade real, além de inflar bastante o tamanho da resposta. Por isso,
 * linhas com o mesmo nome de produto (sem diferenciar maiúsculas/minúsculas
 * ou espaços nas pontas) são agrupadas aqui: a quantidade total é a SOMA de
 * todas as linhas duplicadas, e unidade/categoria/código de barras usam o
 * primeiro valor não vazio encontrado entre elas.
 */
function getEstoqueLevels() {
  return getFromCacheOrCompute_(CACHE_KEY_ESTOQUE, computeEstoqueLevelsJson_);
}

function computeEstoqueLevelsJson_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ESTOQUE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Aba "' + ESTOQUE_SHEET_NAME + '" não encontrada na planilha.');
  }

  const lastProductRow = getLastRowInColumn(sheet, 1);
  const itemsByKey = {};
  const order = [];

  if (lastProductRow >= 2) {
    const rowCount = lastProductRow - 1;
    const lastColumn = sheet.getLastColumn();
    const entradaColumnCount = Math.max(lastColumn - ESTOQUE_START_COLUMN + 1, 0);

    const productNames = sheet.getRange(2, 1, rowCount, 1).getValues();
    const units = sheet.getRange(2, 2, rowCount, 1).getValues();
    const baseValues = sheet.getRange(2, 3, rowCount, 1).getValues();
    const categories = sheet.getRange(2, 4, rowCount, 1).getValues();
    const barcodes = sheet.getRange(2, ESTOQUE_BARCODE_COLUMN, rowCount, 1).getValues();
    const reorderPoints = sheet.getRange(2, ESTOQUE_REORDER_POINT_COLUMN, rowCount, 1).getValues();
    const entradaValues = entradaColumnCount > 0
      ? sheet.getRange(2, ESTOQUE_START_COLUMN, rowCount, entradaColumnCount).getValues()
      : [];

    for (let i = 0; i < rowCount; i++) {
      const produto = String(productNames[i][0] || "").trim();
      if (!produto) continue;

      const un = String(units[i][0] || "").trim();
      const base = Number(baseValues[i][0]) || 0;
      const categoria = String(categories[i][0] || "").trim();
      const codigoBarras = String(barcodes[i][0] || "").trim();
      const pontoPedido = Number(reorderPoints[i][0]) || 0;

      let entradasSum = 0;
      for (let j = 0; j < entradaColumnCount; j++) {
        entradasSum += Number(entradaValues[i][j]) || 0;
      }

      const key = produto.toLowerCase();
      if (!itemsByKey[key]) {
        itemsByKey[key] = { produto: produto, un: un, categoria: categoria, codigoBarras: codigoBarras, pontoPedido: 0, total: 0 };
        order.push(key);
      }

      const agg = itemsByKey[key];
      agg.total += base + entradasSum;
      if (!agg.un && un) agg.un = un;
      if (!agg.categoria && categoria) agg.categoria = categoria;
      if (!agg.codigoBarras && codigoBarras) agg.codigoBarras = codigoBarras;
      if (!agg.pontoPedido && pontoPedido) agg.pontoPedido = pontoPedido;
    }
  }

  const items = order.map(function (key) { return itemsByKey[key]; });

  return JSON.stringify({ status: "success", items: items });
}

// --- PEDIDO DE OBTENÇÃO (DEMANDA / ENVIO POR E-MAIL) ---

/**
 * Retorna os dados de fornecimento da aba "Demanda" (ver comentário da
 * constante DEMANDA_SHEET_NAME), usados para montar o Pedido de Obtenção
 * dos produtos que atingiram o Ponto de Pedido. Se a aba ainda não existir,
 * devolve uma lista vazia em vez de erro (o app trata como "sem dados de
 * fornecedor cadastrados").
 */
function getDemandaData() {
  return getFromCacheOrCompute_(CACHE_KEY_DEMANDA, computeDemandaDataJson_);
}

function computeDemandaDataJson_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DEMANDA_SHEET_NAME);
  const items = [];

  if (sheet) {
    const lastRow = getLastRowInColumn(sheet, 1);
    if (lastRow >= 2) {
      const rowCount = lastRow - 1;
      const values = sheet.getRange(2, 1, rowCount, 8).getValues();
      values.forEach(function (row) {
        const material = String(row[0] || '').trim();
        if (!material) return;
        items.push({
          material: material,
          pontoPedido: Number(row[1]) || 0,
          unidade: String(row[2] || '').trim(),
          categoria: String(row[3] || '').trim(),
          descricaoFornecedor: String(row[4] || '').trim(),
          qtdMinima: Number(row[5]) || 0,
          multiplicador: Number(row[6]) || 0,
          valorUnitario: Number(row[7]) || 0
        });
      });
    }
  }

  return JSON.stringify({ status: "success", items: items });
}

/**
 * Envia por e-mail o PDF do Pedido de Obtenção (gerado no navegador e
 * enviado aqui em base64), para os destinatários informados.
 */
function handleEnviarPedidoObtencao(payload) {
  const destinatarios = Array.isArray(payload.destinatarios) ? payload.destinatarios : [];
  const emailsValidos = destinatarios.map(function (e) { return String(e || '').trim(); }).filter(function (e) { return e; });

  if (emailsValidos.length === 0) {
    throw new Error("Informe pelo menos um destinatário.");
  }
  if (!payload.arquivo || !payload.arquivo.base64) {
    throw new Error("PDF do Pedido de Obtenção não informado.");
  }

  const bytes = Utilities.base64Decode(payload.arquivo.base64);
  const blob = Utilities.newBlob(
    bytes,
    payload.arquivo.mimeType || "application/pdf",
    payload.arquivo.nome || "Pedido de Obtencao.pdf"
  );

  MailApp.sendEmail({
    to: emailsValidos.join(','),
    subject: payload.assunto || "Pedido de Obtenção — Reposição de Estoque",
    body: payload.corpo || "Segue em anexo o Pedido de Obtenção para reposição dos itens que atingiram o Ponto de Pedido no Almoxarifado.",
    attachments: [blob]
  });

  return true;
}

// --- LIBERAÇÃO DE DOCUMENTOS (KANBAN) ---

/**
 * Retorna a aba "Liberacao", criando-a com o cabeçalho correto se ainda
 * não existir.
 */
function getOrCreateLiberacaoSheet(ss) {
  let sheet = ss.getSheetByName(LIBERACAO_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LIBERACAO_SHEET_NAME);
    sheet.appendRow([
      "ID", "Setor", "Titulo", "Descricao", "NomeArquivo", "UrlArquivo",
      "Status", "CriadoEm", "TransmitidoEm", "AprovadoEncarregadoEm",
      "AprovadoImediatoEm", "UltimaAcao", "ItensJSON"
    ]);
  }
  return sheet;
}

/**
 * Retorna a pasta do Google Drive usada para os documentos de liberação,
 * criando-a se ainda não existir.
 *
 * O ID da pasta fica guardado nas Propriedades do Script depois da primeira
 * busca, pra evitar refazer uma busca por nome (DriveApp.getFoldersByName,
 * mais lenta) em toda criação de card — só busca por nome de novo se o ID
 * guardado não existir mais (pasta movida/excluída manualmente).
 */
function getOrCreateLiberacaoFolder() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty('LIBERACAO_FOLDER_ID');

  if (cachedId) {
    try {
      return DriveApp.getFolderById(cachedId);
    } catch (e) {
      // Pasta não existe mais nesse ID (foi movida/excluída) — busca de novo abaixo.
    }
  }

  const folders = DriveApp.getFoldersByName(LIBERACAO_DRIVE_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(LIBERACAO_DRIVE_FOLDER_NAME);
  props.setProperty('LIBERACAO_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * Procura a linha de um card pelo ID (coluna A). Retorna o número da linha
 * ou -1 se não encontrado.
 */
function findLiberacaoRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      return i + 2;
    }
  }
  return -1;
}

function formatLiberacaoTimestamp(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "dd/MM/yy HH:mm");
}

/**
 * O Google Sheets às vezes reconhece o texto "dd/MM/yy HH:mm" gravado pelo
 * script como uma data de verdade e devolve um objeto Date ao ler a célula
 * (em vez do texto original). Esta função normaliza esse valor para sempre
 * sair como texto formatado, seja qual for a forma como o Sheets o guardou.
 */
function formatLiberacaoCell(value) {
  if (value instanceof Date) {
    return formatLiberacaoTimestamp(value);
  }
  return value;
}

function liberacaoRowToCard(row) {
  return {
    id: row[0],
    setor: row[1],
    titulo: row[2],
    descricao: row[3],
    nomeArquivo: row[4],
    urlArquivo: row[5],
    status: row[6],
    criadoEm: formatLiberacaoCell(row[7]),
    transmitidoEm: formatLiberacaoCell(row[8]),
    aprovadoEncarregadoEm: formatLiberacaoCell(row[9]),
    aprovadoImediatoEm: formatLiberacaoCell(row[10]),
    ultimaAcao: row[11],
    itens: parseLiberacaoItens(row[12])
  };
}

/**
 * Faz o parse seguro da coluna ItensJSON (lista [{produto, qtd}, ...]).
 */
function parseLiberacaoItens(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * Cria um novo card na coluna "Setor", salvando o documento anexado (se
 * houver) no Google Drive.
 *
 * Importante: o upload para o Drive (buscar/criar a pasta, criar o arquivo,
 * compartilhar) acontece ANTES de pegar o lock global do script, e portanto
 * FORA dele. O Drive é um serviço separado do Sheets e já garante sua
 * própria consistência — não precisa do nosso lock. Só a gravação da linha
 * na planilha (sheet.appendRow) fica protegida pelo lock, e só por ela, que
 * leva uma fração de segundo. Se o upload (que pode levar vários segundos)
 * acontecesse dentro do lock, TODA outra operação do app — retiradas,
 * entradas, outras ações de liberação, de qualquer computador — ficaria
 * bloqueada esperando até o upload terminar.
 */
function handleLiberacaoCriar(ss, payload) {
  const sheet = getOrCreateLiberacaoSheet(ss);

  const setor = (payload.setor || "").trim();
  const titulo = (payload.titulo || "").trim();
  const descricao = (payload.descricao || "").trim();

  if (!setor) throw new Error("Informe o setor.");
  if (!titulo) throw new Error("Informe o título do documento.");

  let nomeArquivo = "";
  let urlArquivo = "";

  if (payload.arquivo && payload.arquivo.base64) {
    const folder = getOrCreateLiberacaoFolder();
    const bytes = Utilities.base64Decode(payload.arquivo.base64);
    const blob = Utilities.newBlob(
      bytes,
      payload.arquivo.mimeType || "application/octet-stream",
      payload.arquivo.nome || "documento"
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    nomeArquivo = payload.arquivo.nome || file.getName();
    urlArquivo = file.getUrl();
  }

  const id = "LIB-" + new Date().getTime();
  const nowStr = formatLiberacaoTimestamp(new Date());
  const itensJSON = JSON.stringify(payload.itens || []);
  const row = [id, setor, titulo, descricao, nomeArquivo, urlArquivo, "Setor", nowStr, "", "", "", "", itensJSON];

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
    invalidateLiberacaoCache_();
  }

  return liberacaoRowToCard(row);
}

/**
 * Avança um card para a próxima etapa: Setor -> Encarregado (sem senha),
 * Encarregado -> Imediato (senha do Encarregado), Imediato -> Liberados
 * (senha do Imediato).
 */
function handleLiberacaoAvancar(ss, payload) {
  const sheet = getOrCreateLiberacaoSheet(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const id = payload.id;
    if (!id) throw new Error("ID do card não informado.");

    const rowIndex = findLiberacaoRowById(sheet, id);
    if (rowIndex === -1) throw new Error("Card não encontrado.");

    const status = sheet.getRange(rowIndex, 7).getValue();
    const nowStr = formatLiberacaoTimestamp(new Date());

    if (status === "Setor") {
      sheet.getRange(rowIndex, 7).setValue("Encarregado");
      sheet.getRange(rowIndex, 9).setValue(nowStr); // I - TransmitidoEm
    } else if (status === "Encarregado") {
      if (payload.senha !== LIBERACAO_ENCARREGADO_PASSWORD) {
        throw new Error("Senha do Encarregado incorreta.");
      }
      sheet.getRange(rowIndex, 7).setValue("Imediato");
      sheet.getRange(rowIndex, 10).setValue(nowStr); // J - AprovadoEncarregadoEm
      if (payload.itens) {
        sheet.getRange(rowIndex, 13).setValue(JSON.stringify(payload.itens)); // M - ItensJSON
      }
    } else if (status === "Imediato") {
      if (payload.senha !== LIBERACAO_IMEDIATO_PASSWORD) {
        throw new Error("Senha do Imediato incorreta.");
      }
      sheet.getRange(rowIndex, 7).setValue("Liberados");
      sheet.getRange(rowIndex, 11).setValue(nowStr); // K - AprovadoImediatoEm
    } else {
      throw new Error("Este documento já está liberado e não pode avançar mais.");
    }

    const updatedRow = sheet.getRange(rowIndex, 1, 1, 13).getValues()[0];
    return liberacaoRowToCard(updatedRow);

  } finally {
    lock.releaseLock();
    invalidateLiberacaoCache_();
  }
}

/**
 * Recusa um card, devolvendo-o para a coluna anterior: Encarregado -> Setor,
 * Imediato -> Encarregado. Não exige senha.
 */
function handleLiberacaoRecusar(ss, payload) {
  const sheet = getOrCreateLiberacaoSheet(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const id = payload.id;
    if (!id) throw new Error("ID do card não informado.");

    const rowIndex = findLiberacaoRowById(sheet, id);
    if (rowIndex === -1) throw new Error("Card não encontrado.");

    const status = sheet.getRange(rowIndex, 7).getValue();
    const nowStr = formatLiberacaoTimestamp(new Date());

    let novoStatus;
    let etapa;
    if (status === "Encarregado") {
      novoStatus = "Setor";
      etapa = "Encarregado";
    } else if (status === "Imediato") {
      novoStatus = "Encarregado";
      etapa = "Imediato";
    } else {
      throw new Error("Este documento não pode ser recusado nesta etapa.");
    }

    sheet.getRange(rowIndex, 7).setValue(novoStatus);
    sheet.getRange(rowIndex, 12).setValue("Recusado pelo " + etapa + " em " + nowStr); // L - UltimaAcao

    const updatedRow = sheet.getRange(rowIndex, 1, 1, 13).getValues()[0];
    return liberacaoRowToCard(updatedRow);

  } finally {
    lock.releaseLock();
    invalidateLiberacaoCache_();
  }
}

/**
 * Exclui um card, mas apenas se ele ainda estiver na coluna "Setor" (antes de
 * ser transmitido para aprovação). Também move o arquivo anexado, se houver,
 * para a lixeira do Google Drive.
 *
 * Assim como em handleLiberacaoCriar, a chamada ao Drive (mover o arquivo
 * pra lixeira) acontece DEPOIS de já ter soltado o lock — ela é uma
 * requisição de rede separada e não deve travar o resto do app enquanto
 * acontece.
 */
function handleLiberacaoExcluir(ss, payload) {
  const sheet = getOrCreateLiberacaoSheet(ss);

  const id = payload.id;
  if (!id) throw new Error("ID do card não informado.");

  const rowIndex = findLiberacaoRowById(sheet, id);
  if (rowIndex === -1) throw new Error("Card não encontrado.");

  const status = sheet.getRange(rowIndex, 7).getValue();
  if (status !== "Setor") {
    throw new Error("Só é possível excluir documentos que ainda estão na coluna Setor.");
  }

  const urlArquivo = sheet.getRange(rowIndex, 6).getValue();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.deleteRow(rowIndex);
  } finally {
    lock.releaseLock();
    invalidateLiberacaoCache_();
  }

  if (urlArquivo) {
    try {
      const fileId = getDriveFileIdFromUrl(urlArquivo);
      if (fileId) {
        DriveApp.getFileById(fileId).setTrashed(true);
      }
    } catch (e) {
      // Se não conseguir apagar o arquivo do Drive, a linha já foi removida mesmo assim.
    }
  }

  return true;
}

/**
 * Extrai o ID de um arquivo do Google Drive a partir da URL gerada por
 * file.getUrl().
 */
function getDriveFileIdFromUrl(url) {
  const match = String(url).match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

/**
 * Retorna todos os cards da esteira de liberação.
 */
function getLiberacaoCards() {
  return getFromCacheOrCompute_(CACHE_KEY_LIBERACAO, computeLiberacaoCardsJson_);
}

function computeLiberacaoCardsJson_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateLiberacaoSheet(ss);
  const lastRow = sheet.getLastRow();
  const cards = [];

  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
    values.forEach(function (row) {
      if (!row[0]) return;
      cards.push(liberacaoRowToCard(row));
    });
  }

  return JSON.stringify({ status: "success", cards: cards });
}
