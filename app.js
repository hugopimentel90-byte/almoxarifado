// URL da planilha do Google Sheets publicada como CSV
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTwMkf7LbwKuzddFgZCu0aFeV5rhA9DgRiIMGfG9oGFo6DcLKRDZoscpMzHELn0rmrqvCbq_SMPJzn2/pub?gid=0&single=true&output=csv";

// URL do Web App do Google Apps Script para salvar retiradas diretamente na planilha
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxEoyguK7MWwKmlboAuVeYYG_syL4j1e4sx0KWZ9TzilxjRHc494-kqiyJYHhjScOnh/exec";

// Chave para armazenamento de retiradas locais
const LOCAL_STORAGE_KEY = "almoxarifado_retiradas_locais";

// Chave para persistir a preferência de menu lateral recolhido
const SIDEBAR_COLLAPSE_KEY = "almoxarifado_sidebar_collapsed";

// Senha de liberação exigida para confirmar o envio de retiradas e entradas à planilha
const RELEASE_PASSWORD = "almoxarife";

// Variáveis de Estado Global
let rawData = [];
let currentFilteredData = [];
let chartInstances = {};

// Estado da Aba de Retirada
let selectedCategory = "";
let uniqueProductNamesForCategory = [];
let selectedItemsDetails = new Map(); // Armazena { nomeProduto => { qtd: X, un: Y } }

// Estado do cronômetro de Tempo de Retirada
let withdrawalTimerState = 'idle'; // idle | running | paused | finished
let withdrawalTimerStartTimestamp = null; // Date.now() do último (re)início
let withdrawalTimerAccumulatedMs = 0; // ms acumulados entre pausas/retomadas
let withdrawalTimerIntervalId = null;
let withdrawalElapsedMinutes = null; // valor final capturado (cronômetro ou manual), null = ainda não registrado

// Estado da Aba de Entrada de Material
let uniqueProductNamesForEntrada = [];
let selectedEntradaItemsDetails = new Map(); // Armazena { nomeProduto => { qtd: X, un: Y, categoria?: Z } }
let entradaCustomCategories = {}; // Lembra a categoria escolhida para materiais novos, mesmo se desmarcados e remarcados
let pendingCustomEntradaProductName = '';

// Estado da Aba de Consulta de Estoque
let stockData = []; // Armazena [{ produto, un, total }] vindo da aba "Estoque"
let currentEstoqueCategory = "";
let estoqueSearchQuery = "";

// Lista de colunas obrigatórias
const REQUIRED_HEADERS = ['produto', 'qtd', 'un', 'data', 'setor', 'pedido', 'mes', 'categoria', 'precomedio'];

// Nomes dos meses em português para exibição
const MONTH_NAMES = {
  1: 'Janeiro', 2: 'Fevereiro', 3: 'Março', 4: 'Abril',
  5: 'Maio', 6: 'Junho', 7: 'Julho', 8: 'Agosto',
  9: 'Setembro', 10: 'Outubro', 11: 'Novembro', 12: 'Dezembro'
};

// Opções padrão para unidades de medida
const UNIT_OPTIONS = ['un', 'rolo', 'resma', 'pacote', 'litro', 'balde', 'caixa', 'metro', 'unidade'];

// --- FUNÇÕES DE SUPORTE ---

function normalizeHeader(str) {
  return str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function detectSeparator(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const semicolons = (headerLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCSVLine(line, separator) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === separator && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
  const date = new Date(year, month, day);
  return isNaN(date.getTime()) ? null : date;
}

function parseNumber(numStr) {
  if (!numStr) return 0;
  let clean = numStr.trim().replace(/\s/g, '');
  if (clean.includes(',') && !clean.includes('.')) {
    clean = clean.replace(',', '.');
  } else if (clean.includes('.') && clean.includes(',')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  }
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : val;
}

// --- PERSISTÊNCIA LOCAL (LOCAL STORAGE) ---

function getLocalWithdrawals() {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    // Converte a string de data de volta para objeto Date
    return parsed.map(item => {
      item.data = new Date(item.data);
      return item;
    });
  } catch (e) {
    console.error("Erro ao carregar retiradas locais do LocalStorage:", e);
    return [];
  }
}

function saveLocalWithdrawal(items) {
  const localList = getLocalWithdrawals();
  const updatedList = [...localList, ...items];
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updatedList));
}

// --- CARREGAMENTO E SINCRO DE DADOS ---

async function fetchDashboardData() {
  showLoading(true);
  hideError();

  try {
    const cacheBuster = `&t=${new Date().getTime()}`;
    const response = await fetch(`${CSV_URL}${cacheBuster}`, {
      cache: "no-store",
      headers: {
        'pragma': 'no-cache',
        'cache-control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`Falha na requisição HTTP: ${response.status} ${response.statusText}`);
    }

    const csvText = await response.text();
    const lines = csvText.split(/\r?\n/);

    if (lines.length < 2) {
      throw new Error("O arquivo CSV está vazio ou não possui registros válidos.");
    }

    const separator = detectSeparator(lines[0]);
    const headers = parseCSVLine(lines[0], separator);

    const headerIndexes = {};
    headers.forEach((header, index) => {
      const norm = normalizeHeader(header);
      headerIndexes[norm] = index;
    });

    const missingHeaders = REQUIRED_HEADERS.filter(h => headerIndexes[h] === undefined);
    if (missingHeaders.length > 0) {
      throw new Error(`Colunas obrigatórias ausentes na planilha: ${missingHeaders.join(', ')}`);
    }

    rawData = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cells = parseCSVLine(line, separator);
      const produtoVal = cells[headerIndexes['produto']];
      const dataVal = cells[headerIndexes['data']];
      const qtdVal = cells[headerIndexes['qtd']];

      if (!produtoVal || !dataVal || !qtdVal) continue;

      const dateObj = parseDate(dataVal);
      if (!dateObj) continue;

      const qtdNum = parseNumber(qtdVal);
      if (qtdNum <= 0) continue;

      rawData.push({
        produto: produtoVal,
        qtd: qtdNum,
        un: cells[headerIndexes['un']] || '',
        data: dateObj,
        dataStr: dataVal,
        setor: cells[headerIndexes['setor']] || 'Não Especificado',
        pedido: cells[headerIndexes['pedido']] || 'Sem Pedido',
        observacao: cells[headerIndexes['observacao']] || '',
        pagoEm: cells[headerIndexes['pagoem']] || '',
        mes: parseInt(cells[headerIndexes['mes']], 10) || (dateObj.getMonth() + 1),
        categoria: cells[headerIndexes['categoria']] || 'Outros',
        precoMedio: parseNumber(cells[headerIndexes['precomedio']])
      });
    }

    // --- SINCRO: Mescla dados do LocalStorage ---
    let localWithdrawals = getLocalWithdrawals();
    if (localWithdrawals.length > 0) {
      // Filtra itens do localStorage que ainda NÃO foram publicados no CSV
      const newLocalWithdrawals = localWithdrawals.filter(localItem => {
        const alreadyInCsv = rawData.some(csvItem =>
          csvItem.produto === localItem.produto &&
          csvItem.qtd === localItem.qtd &&
          csvItem.pedido === localItem.pedido &&
          csvItem.setor === localItem.setor &&
          csvItem.dataStr === localItem.dataStr
        );
        return !alreadyInCsv;
      });

      // Se alguns itens já foram publicados no CSV, atualiza o localStorage limpando-os
      if (newLocalWithdrawals.length !== localWithdrawals.length) {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newLocalWithdrawals));
      }

      rawData = [...rawData, ...newLocalWithdrawals];
    }

    if (rawData.length === 0) {
      throw new Error("Nenhum registro foi processado corretamente.");
    }

    // Renderiza a interface
    populateFilters();
    applyFilters();
    updateLastUpdatedTime();
    populateFormSectors();
    populateConsumoLimiteSetorFilter();
    renderConsumoLimiteSetor();

  } catch (error) {
    console.error("Erro no processamento dos dados do Dashboard:", error);
    showError(error.message);
  } finally {
    showLoading(false);
  }
}

// --- INTERFACE DE NAVEGAÇÃO E NAVEGAÇÃO ---

function switchTab(tabName) {
  const menuDashboard = document.getElementById('menuDashboard');
  const menuRetirada = document.getElementById('menuRetirada');
  const menuEntrada = document.getElementById('menuEntrada');
  const menuEstoque = document.getElementById('menuEstoque');
  const viewDashboard = document.getElementById('viewDashboard');
  const viewRetirada = document.getElementById('viewRetirada');
  const viewEntrada = document.getElementById('viewEntrada');
  const viewEstoque = document.getElementById('viewEstoque');

  menuDashboard.classList.remove('active');
  menuRetirada.classList.remove('active');
  menuEntrada.classList.remove('active');
  menuEstoque.classList.remove('active');
  viewDashboard.classList.add('hidden');
  viewRetirada.classList.add('hidden');
  viewEntrada.classList.add('hidden');
  viewEstoque.classList.add('hidden');

  if (tabName === 'dashboard') {
    menuDashboard.classList.add('active');
    viewDashboard.classList.remove('hidden');

    // Força redibujo dos gráficos ao abrir
    updateCharts();
  } else if (tabName === 'retirada') {
    menuRetirada.classList.add('active');
    viewRetirada.classList.remove('hidden');
    resetWithdrawalForm();
    showRetiradaScreen('categories');
  } else if (tabName === 'entrada') {
    menuEntrada.classList.add('active');
    viewEntrada.classList.remove('hidden');
    openEntradaForm();
  } else if (tabName === 'estoque') {
    menuEstoque.classList.add('active');
    viewEstoque.classList.remove('hidden');
    showEstoqueScreen('categories');
    fetchStockLevels();
  }
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0');

  const btn = document.getElementById('btnToggleSidebar');
  if (btn) {
    const label = collapsed ? 'Expandir menu' : 'Recolher menu';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
}

function initSidebarToggle() {
  const btn = document.getElementById('btnToggleSidebar');
  if (!btn) return;

  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1');

  btn.addEventListener('click', () => {
    setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  });
}

function showRetiradaScreen(screen) {
  const categorySelection = document.getElementById('retiradaCategorySelection');
  const formSection = document.getElementById('retiradaFormSection');

  if (screen === 'categories') {
    categorySelection.classList.remove('hidden');
    formSection.classList.add('hidden');
  } else if (screen === 'form') {
    categorySelection.classList.add('hidden');
    formSection.classList.remove('hidden');
  }
}

// --- FILTROS DE DASHBOARD ---

function populateFilters() {
  const monthSelect = document.getElementById('filterMonth');
  const sectorSelect = document.getElementById('filterSector');
  const categorySelect = document.getElementById('filterCategory');

  monthSelect.innerHTML = '<option value="all">Todos os Meses</option>';
  sectorSelect.innerHTML = '<option value="all">Todos os Setores</option>';
  categorySelect.innerHTML = '<option value="all">Todas as Categorias</option>';

  const uniqueMonths = [...new Set(rawData.map(item => item.mes))].sort((a, b) => a - b);
  uniqueMonths.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = MONTH_NAMES[m] || `Mês ${m}`;
    monthSelect.appendChild(opt);
  });

  const uniqueSectors = [...new Set(rawData.map(item => item.setor))].sort();
  uniqueSectors.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sectorSelect.appendChild(opt);
  });

  const uniqueCategories = [...new Set(rawData.map(item => item.categoria))].sort();
  uniqueCategories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    categorySelect.appendChild(opt);
  });

  const dates = rawData.map(item => item.data);
  if (dates.length > 0) {
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));

    const toISODate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    document.getElementById('filterDateStart').value = toISODate(minDate);
    document.getElementById('filterDateEnd').value = toISODate(maxDate);
  }
}

function applyFilters() {
  const dateStartVal = document.getElementById('filterDateStart').value;
  const dateEndVal = document.getElementById('filterDateEnd').value;
  const monthVal = document.getElementById('filterMonth').value;
  const sectorVal = document.getElementById('filterSector').value;
  const categoryVal = document.getElementById('filterCategory').value;

  const start = dateStartVal ? new Date(dateStartVal + 'T00:00:00') : null;
  const end = dateEndVal ? new Date(dateEndVal + 'T23:59:59') : null;

  currentFilteredData = rawData.filter(item => {
    if (start && item.data < start) return false;
    if (end && item.data > end) return false;
    if (monthVal !== 'all' && item.mes.toString() !== monthVal) return false;
    if (sectorVal !== 'all' && item.setor !== sectorVal) return false;
    if (categoryVal !== 'all' && item.categoria !== categoryVal) return false;
    return true;
  });

  updateKPIs();
  updateCharts();
}

function populateFormSectors() {
  const formSector = document.getElementById('formSector');
  formSector.innerHTML = '<option value="">Selecione o setor...</option>';

  const uniqueSectors = [...new Set(rawData.map(item => item.setor))].sort();
  uniqueSectors.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    formSector.appendChild(opt);
  });
}

// --- RENDERIZAÇÃO DE INDICADORES (KPIs) ---

function updateKPIs() {
  const totalItems = currentFilteredData.reduce((acc, item) => acc + item.qtd, 0);
  document.getElementById('kpiTotalItems').textContent = formatDataLabelValue(totalItems);

  const uniqueOrders = new Set(currentFilteredData.map(item => item.pedido).filter(p => p && p !== 'Sem Pedido'));
  document.getElementById('kpiTotalOrders').textContent = uniqueOrders.size.toLocaleString('pt-BR');

  const uniqueSectors = new Set(currentFilteredData.map(item => item.setor));
  document.getElementById('kpiTotalSectors').textContent = uniqueSectors.size.toLocaleString('pt-BR');

  const uniqueCategories = new Set(currentFilteredData.map(item => item.categoria));
  document.getElementById('kpiTotalCategories').textContent = uniqueCategories.size.toLocaleString('pt-BR');
}

// --- INTEGRAÇÃO COM CHART.JS ---

if (typeof ChartDataLabels !== 'undefined') {
  Chart.register(ChartDataLabels);
}

function formatDataLabelValue(value) {
  return Math.ceil(Number(value) || 0).toLocaleString('pt-BR');
}

function updateChart(canvasId, type, labels, datasets, options = {}) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
  }

  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  const defaultPlugins = {
    legend: {
      display: type === 'doughnut',
      labels: { font: { family: 'Inter', size: 11, weight: '500' } }
    },
    tooltip: {
      titleFont: { family: 'Inter', size: 12, weight: 'bold' },
      bodyFont: { family: 'Inter', size: 12 }
    },
    datalabels: {
      display: false
    }
  };

  const mergedOptions = Object.assign({
    responsive: true,
    maintainAspectRatio: false
  }, options);
  mergedOptions.plugins = Object.assign({}, defaultPlugins, options.plugins);

  chartInstances[canvasId] = new Chart(ctx, {
    type: type,
    data: {
      labels: labels,
      datasets: datasets
    },
    options: mergedOptions
  });
}

function updateCharts() {
  // 1. Linha do Tempo
  const timelineData = {};
  currentFilteredData.forEach(item => {
    const key = item.data.toISOString().split('T')[0];
    timelineData[key] = (timelineData[key] || 0) + item.qtd;
  });
  const sortedDates = Object.keys(timelineData).sort();
  const timelineLabels = sortedDates.map(dStr => {
    const d = new Date(dStr + 'T00:00:00');
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  });
  const timelineValues = sortedDates.map(d => timelineData[d]);

  updateChart('chartTimeline', 'line', timelineLabels, [{
    label: 'Volume de Itens',
    data: timelineValues,
    borderColor: '#2563eb',
    backgroundColor: 'rgba(37, 99, 235, 0.05)',
    fill: true,
    tension: 0.3,
    borderWidth: 2,
    pointRadius: timelineValues.length > 30 ? 0 : 3,
    pointHoverRadius: 6
  }], {
    layout: {
      padding: { top: 20 }
    },
    scales: {
      y: { grid: { color: 'rgba(226, 232, 240, 0.4)' }, ticks: { font: { family: 'Inter' } } },
      x: { grid: { display: false }, ticks: { font: { family: 'Inter' } } }
    },
    plugins: {
      datalabels: {
        display: timelineValues.length <= 30,
        align: 'top',
        anchor: 'end',
        offset: 4,
        clamp: true,
        color: '#2563eb',
        font: { family: 'Inter', size: 10, weight: '600' },
        formatter: formatDataLabelValue
      }
    }
  });

  // 2. Top 10 Produtos
  const productQuantities = {};
  currentFilteredData.forEach(item => {
    productQuantities[item.produto] = (productQuantities[item.produto] || 0) + item.qtd;
  });
  const topProducts = Object.entries(productQuantities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const prodLabels = topProducts.map(p => p[0]);
  const prodValues = topProducts.map(p => p[1]);

  updateChart('chartTopProducts', 'bar', prodLabels, [{
    label: 'Itens Solicitados',
    data: prodValues,
    backgroundColor: '#0d9488',
    borderRadius: 4,
    barThickness: 14
  }], {
    indexAxis: 'y',
    layout: {
      padding: { right: 32 }
    },
    scales: {
      x: { grid: { color: 'rgba(226, 232, 240, 0.4)' }, ticks: { font: { family: 'Inter' } } },
      y: { grid: { display: false }, ticks: { font: { family: 'Inter' } } }
    },
    plugins: {
      datalabels: {
        display: true,
        align: 'end',
        anchor: 'end',
        offset: 4,
        clamp: true,
        color: '#0d9488',
        font: { family: 'Inter', size: 11, weight: '600' },
        formatter: formatDataLabelValue
      }
    }
  });

  // 3. Distribuição por Categoria
  const categoryData = {};
  currentFilteredData.forEach(item => {
    categoryData[item.categoria] = (categoryData[item.categoria] || 0) + item.qtd;
  });
  const sortedCategories = Object.entries(categoryData).sort((a, b) => b[1] - a[1]);
  const catLabels = sortedCategories.map(c => c[0]);
  const catValues = sortedCategories.map(c => c[1]);

  updateChart('chartCategories', 'doughnut', catLabels, [{
    data: catValues,
    backgroundColor: ['#2563eb', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#64748b', '#0d9488', '#f43f5e'],
    borderWidth: 2,
    borderColor: '#ffffff'
  }], {
    layout: {
      padding: 16
    },
    plugins: {
      legend: {
        position: 'right',
        labels: { font: { family: 'Inter', size: 10 } }
      },
      datalabels: {
        display: true,
        clamp: true,
        color: '#ffffff',
        font: { family: 'Inter', size: 11, weight: '700' },
        formatter: formatDataLabelValue
      }
    }
  });

  // 4. Consumo por Setor
  const sectorData = {};
  currentFilteredData.forEach(item => {
    sectorData[item.setor] = (sectorData[item.setor] || 0) + item.qtd;
  });
  const topSectors = Object.entries(sectorData)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const secLabels = topSectors.map(s => s[0]);
  const secValues = topSectors.map(s => s[1]);

  updateChart('chartSectors', 'bar', secLabels, [{
    label: 'Itens por Setor',
    data: secValues,
    backgroundColor: '#8b5cf6',
    borderRadius: 4,
    barThickness: 16
  }], {
    layout: {
      padding: { top: 20 }
    },
    scales: {
      y: { grid: { color: 'rgba(226, 232, 240, 0.4)' }, ticks: { font: { family: 'Inter' } } },
      x: { grid: { display: false }, ticks: { font: { family: 'Inter' } } }
    },
    plugins: {
      datalabels: {
        display: true,
        align: 'end',
        anchor: 'end',
        offset: 4,
        clamp: true,
        color: '#8b5cf6',
        font: { family: 'Inter', size: 11, weight: '600' },
        formatter: formatDataLabelValue
      }
    }
  });
}

// --- PAINEL DE CONSUMO LIMITE POR SETOR ---

function populateConsumoLimiteSetorFilter() {
  const select = document.getElementById('consumoLimiteSetorFilter');
  const previousValue = select.value;
  select.innerHTML = '<option value="">Selecione um setor...</option>';

  const uniqueSectors = [...new Set(rawData.map(item => item.setor))].sort();
  uniqueSectors.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });

  if (uniqueSectors.includes(previousValue)) {
    select.value = previousValue;
  }
}

/**
 * Calcula, para cada produto já consumido por um setor, a média mensal dos
 * últimos meses anteriores ao atual (com dados na base, até 3), o quanto já
 * foi retirado no mês atual, e o quanto ainda resta dentro dessa média.
 * Retorna um objeto { produto: { average, consumedThisMonth, remaining } }.
 */
function computeConsumoLimiteForSector(setor) {
  if (!setor) return {};

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-11

  // Últimos 3 meses anteriores ao mês presente (sem incluir o mês presente)
  const priorMonths = [1, 2, 3].map(offset => {
    const d = new Date(currentYear, currentMonth - offset, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const sectorItems = rawData.filter(item => item.setor === setor);

  const priorMonthsSumByProduct = {};
  const currentMonthSumByProduct = {};

  sectorItems.forEach(item => {
    const itemYear = item.data.getFullYear();
    const itemMonth = item.data.getMonth();

    if (itemYear === currentYear && itemMonth === currentMonth) {
      currentMonthSumByProduct[item.produto] = (currentMonthSumByProduct[item.produto] || 0) + item.qtd;
    } else if (priorMonths.some(m => m.year === itemYear && m.month === itemMonth)) {
      priorMonthsSumByProduct[item.produto] = (priorMonthsSumByProduct[item.produto] || 0) + item.qtd;
    }
  });

  // A média divide pela quantidade de meses anteriores que realmente têm dados
  // na base para este setor (até 3), não sempre por 3.
  const monthsWithData = priorMonths.filter(m =>
    sectorItems.some(item => item.data.getFullYear() === m.year && item.data.getMonth() === m.month)
  ).length;
  const averageDivisor = monthsWithData > 0 ? monthsWithData : 1;

  const allProducts = new Set([
    ...Object.keys(priorMonthsSumByProduct),
    ...Object.keys(currentMonthSumByProduct)
  ]);

  const result = {};
  allProducts.forEach(produto => {
    const average = (priorMonthsSumByProduct[produto] || 0) / averageDivisor;
    const consumedThisMonth = currentMonthSumByProduct[produto] || 0;
    const remaining = Math.max(average - consumedThisMonth, 0);
    result[produto] = { average, consumedThisMonth, remaining };
  });

  return result;
}

function renderConsumoLimiteSetor() {
  const setor = document.getElementById('consumoLimiteSetorFilter').value;
  const tbody = document.getElementById('consumoLimiteSetorTableBody');
  tbody.innerHTML = '';

  if (!setor) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 2rem;">Selecione um setor para consultar</td></tr>`;
    return;
  }

  const limiteInfo = computeConsumoLimiteForSector(setor);
  const rows = Object.keys(limiteInfo)
    .map(produto => ({ produto, ...limiteInfo[produto] }))
    .sort((a, b) => a.produto.localeCompare(b.produto));

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 2rem;">Nenhum consumo encontrado para este setor</td></tr>`;
    return;
  }

  rows.forEach(row => {
    const tr = document.createElement('tr');
    const limitReached = row.consumedThisMonth >= row.average;

    tr.innerHTML = `
      <td style="font-weight: 600; color: var(--text-primary);">${row.produto}</td>
      <td>${formatDataLabelValue(row.average)}</td>
      <td>${formatDataLabelValue(row.consumedThisMonth)}</td>
      <td style="font-weight: 600; color: ${limitReached ? 'var(--color-danger)' : 'var(--color-success)'};">${formatDataLabelValue(row.remaining)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function exportConsumoLimiteSetorPDF() {
  const setor = document.getElementById('consumoLimiteSetorFilter').value;

  if (!setor) {
    showToast("Selecione um setor antes de extrair o PDF.", "error");
    return;
  }

  const limiteInfo = computeConsumoLimiteForSector(setor);
  const rows = Object.keys(limiteInfo)
    .map(produto => ({ produto, ...limiteInfo[produto] }))
    .sort((a, b) => a.produto.localeCompare(b.produto));

  if (rows.length === 0) {
    showToast("Nenhum consumo encontrado para este setor.", "warning");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const now = new Date();
  const generatedAt = `${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR')}`;

  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text('Consumo Limite por Setor', 14, 18);

  doc.setFontSize(11);
  doc.setTextColor(71, 85, 105);
  doc.text(`Setor: ${setor}`, 14, 26);
  doc.text(`Gerado em: ${generatedAt}`, 14, 32);

  const tableBody = rows.map(row => [
    row.produto,
    formatDataLabelValue(row.average),
    formatDataLabelValue(row.consumedThisMonth),
    formatDataLabelValue(row.remaining)
  ]);

  doc.autoTable({
    startY: 38,
    head: [['Produto', 'Média Mensal (3 meses anteriores)', 'Retirado no Mês Atual', 'Disponível para Retirar']],
    body: tableBody,
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] }
  });

  const fileSafeSetor = setor.replace(/[^a-zA-Z0-9]+/g, '_');
  const fileDate = now.toISOString().split('T')[0];
  doc.save(`Consumo_Limite_${fileSafeSetor}_${fileDate}.pdf`);
}

// --- MÓDULO DE RETIRADA (FORMULÁRIO E LÓGICA) ---

function initializeWithdrawalModule() {
  // Click nos Cards de Categoria
  document.querySelectorAll('#retiradaCategorySelection .category-card').forEach(card => {
    card.addEventListener('click', () => {
      const category = card.getAttribute('data-category');
      openWithdrawalForm(category);
    });
  });

  // Botão Voltar
  document.getElementById('btnGoBackCategories').addEventListener('click', () => {
    showRetiradaScreen('categories');
  });

  // Botão dropdown multiselect
  const btnSelect = document.getElementById('btnSelectItems');
  const dropdown = document.getElementById('itemsDropdown');

  btnSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  // Fecha dropdown ao clicar fora
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== btnSelect && !btnSelect.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  // Input de Busca no dropdown
  document.getElementById('itemsDropdownSearch').addEventListener('input', (e) => {
    renderMultiselectOptions(e.target.value);
  });

  // Botões de Cancelar/Confirmar
  document.getElementById('btnCancelWithdrawal').addEventListener('click', () => {
    showRetiradaScreen('categories');
  });

  document.getElementById('btnSubmitWithdrawal').addEventListener('click', handleWithdrawalFormSubmit);

  // Modal de confirmação (data de pagamento + senha de liberação)
  document.getElementById('btnCancelConfirmModal').addEventListener('click', closeConfirmationModal);
  document.getElementById('btnConfirmWithdrawalPassword').addEventListener('click', handleConfirmWithdrawalPassword);

  document.getElementById('confirmPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirmWithdrawalPassword();
    }
  });

  // Fecha o modal ao clicar fora do card
  document.getElementById('confirmWithdrawalModal').addEventListener('click', (e) => {
    if (e.target.id === 'confirmWithdrawalModal') {
      closeConfirmationModal();
    }
  });

  // Modal de aviso de estoque insuficiente
  document.getElementById('btnCloseInsufficientStockModal').addEventListener('click', closeInsufficientStockModal);
  document.getElementById('insufficientStockModal').addEventListener('click', (e) => {
    if (e.target.id === 'insufficientStockModal') {
      closeInsufficientStockModal();
    }
  });

  // Cronômetro de Tempo de Retirada
  document.getElementById('btnTimerStart').addEventListener('click', handleTimerStart);
  document.getElementById('btnTimerPause').addEventListener('click', handleTimerPause);
  document.getElementById('btnTimerResume').addEventListener('click', handleTimerResume);
  document.getElementById('btnTimerFinish').addEventListener('click', handleTimerFinish);
  document.getElementById('btnTimerReset').addEventListener('click', handleTimerReset);
  document.getElementById('formManualTime').addEventListener('input', handleManualTimeInput);
}

function openWithdrawalForm(category) {
  selectedCategory = category;
  document.getElementById('selectedCategoryTitle').textContent = category;

  // Limpa estado anterior do formulário
  selectedItemsDetails.clear();
  document.getElementById('itemsDropdownSearch').value = '';
  document.getElementById('formOrderNumber').value = '';
  document.getElementById('formSector').value = '';
  resetWithdrawalTimer();

  // Filtra itens com base na categoria selecionada
  let items = rawData.filter(item => item.categoria.toLowerCase() === category.toLowerCase());

  // Se a categoria for "Prefeitura" (ou outra sem produtos correspondentes), listamos todos como fallback
  if (items.length === 0) {
    items = rawData;
  }

  // Lista única ordenada dos produtos
  uniqueProductNamesForCategory = [...new Set(items.map(item => item.produto))].sort();

  // Renderiza opções no checklist
  renderMultiselectOptions();
  updateMultiselectLabel();
  renderSelectedItemsRows();

  showRetiradaScreen('form');
}

function renderMultiselectOptions(searchQuery = '') {
  const container = document.getElementById('itemsOptionsContainer');
  container.innerHTML = '';

  const filtered = uniqueProductNamesForCategory.filter(name =>
    name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 0.5rem 1rem; color: var(--text-muted); font-size: 0.875rem;">Nenhum produto encontrado</div>`;
    return;
  }

  filtered.forEach(name => {
    const div = document.createElement('div');
    div.className = 'multiselect-option';

    const isChecked = selectedItemsDetails.has(name);
    const safeId = `chk-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // O <label> envolve todo o conteúdo da linha, garantindo que o clique
    // em qualquer ponto (texto ou caixa) alterne o checkbox exatamente uma vez.
    div.innerHTML = `
      <label style="display:flex;align-items:center;gap:0.5rem;width:100%;cursor:pointer;user-select:none;" for="${safeId}">
        <input type="checkbox" id="${safeId}" ${isChecked ? 'checked' : ''}>
        <span style="flex-grow:1;">${name}</span>
      </label>
    `;

    div.querySelector('input').addEventListener('change', (e) => {
      toggleItemSelection(name, e.target.checked);
    });

    container.appendChild(div);
  });
}

function toggleItemSelection(name, isChecked) {
  if (isChecked) {
    // Busca a última unidade usada desse produto para sugerir por padrão
    const match = rawData.find(item => item.produto === name);
    const defaultUnit = match ? match.un : 'un';

    selectedItemsDetails.set(name, {
      qtd: 1,
      un: defaultUnit
    });
  } else {
    selectedItemsDetails.delete(name);
  }

  updateMultiselectLabel();
  renderSelectedItemsRows();
}

function updateMultiselectLabel() {
  const label = document.getElementById('multiselectLabel');
  const count = selectedItemsDetails.size;

  if (count === 0) {
    label.textContent = "Selecione os produtos...";
    label.style.color = 'var(--text-muted)';
  } else if (count === 1) {
    label.textContent = `${count} produto selecionado`;
    label.style.color = 'var(--text-primary)';
  } else {
    label.textContent = `${count} produtos selecionados`;
    label.style.color = 'var(--text-primary)';
  }
}

function renderSelectedItemsRows() {
  const container = document.getElementById('selectedItemsRowsContainer');
  container.innerHTML = '';

  if (selectedItemsDetails.size === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  selectedItemsDetails.forEach((details, name) => {
    const row = document.createElement('div');
    row.className = 'selected-item-row selected-item-row--with-delete';

    // Coluna 1: Nome do produto
    const nameEl = document.createElement('div');
    nameEl.className = 'selected-item-name';
    nameEl.textContent = name;
    nameEl.title = name;
    row.appendChild(nameEl);

    // Coluna 2: Seletor de Quantidade (+ e -)
    const qtyControl = document.createElement('div');
    qtyControl.className = 'quantity-control';

    const btnMinus = document.createElement('button');
    btnMinus.className = 'quantity-btn';
    btnMinus.textContent = '−';
    btnMinus.onclick = () => {
      const input = qtyControl.querySelector('input');
      let val = parseInt(input.value, 10) || 1;
      if (val > 1) {
        val--;
        input.value = val;
        updateItemQty(name, val);
      }
    };

    const inputQty = document.createElement('input');
    inputQty.type = 'number';
    inputQty.className = 'quantity-input';
    inputQty.value = details.qtd;
    inputQty.min = 1;
    inputQty.onchange = (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      e.target.value = val;
      updateItemQty(name, val);
    };

    const btnPlus = document.createElement('button');
    btnPlus.className = 'quantity-btn';
    btnPlus.textContent = '+';
    btnPlus.onclick = () => {
      const input = qtyControl.querySelector('input');
      let val = parseInt(input.value, 10) || 1;
      val++;
      input.value = val;
      updateItemQty(name, val);
    };

    qtyControl.appendChild(btnMinus);
    qtyControl.appendChild(inputQty);
    qtyControl.appendChild(btnPlus);
    row.appendChild(qtyControl);

    // Coluna 3: Seletor de Unidade (Dropdown)
    const unitSelect = document.createElement('select');
    unitSelect.style.width = '100%';
    unitSelect.style.padding = '0.4rem';
    unitSelect.style.fontSize = '0.875rem';
    unitSelect.style.borderRadius = 'var(--radius-sm)';
    unitSelect.style.border = '1px solid var(--border-color)';
    unitSelect.style.fontFamily = 'var(--font-family)';

    UNIT_OPTIONS.forEach(unit => {
      const opt = document.createElement('option');
      opt.value = unit;
      opt.textContent = unit;
      if (unit === details.un) opt.selected = true;
      unitSelect.appendChild(opt);
    });

    unitSelect.onchange = (e) => {
      updateItemUnit(name, e.target.value);
    };

    row.appendChild(unitSelect);

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'selected-item-delete-btn';
    btnDelete.title = 'Remover item';
    btnDelete.innerHTML = `
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
      </svg>
    `;
    btnDelete.addEventListener('click', () => {
      removeWithdrawalItem(name);
    });
    row.appendChild(btnDelete);

    container.appendChild(row);
  });
}

function removeWithdrawalItem(name) {
  selectedItemsDetails.delete(name);
  updateMultiselectLabel();
  renderSelectedItemsRows();
  renderMultiselectOptions(document.getElementById('itemsDropdownSearch').value);
}

function updateItemQty(name, qty) {
  if (selectedItemsDetails.has(name)) {
    selectedItemsDetails.get(name).qtd = qty;
  }
}

function updateItemUnit(name, unit) {
  if (selectedItemsDetails.has(name)) {
    selectedItemsDetails.get(name).un = unit;
  }
}

function handleWithdrawalFormSubmit() {
  const sector = document.getElementById('formSector').value;
  const orderNumber = document.getElementById('formOrderNumber').value.trim();

  // Validações
  if (selectedItemsDetails.size === 0) {
    showToast("Por favor, selecione pelo menos um produto.", "error");
    return;
  }
  if (!sector) {
    showToast("Por favor, selecione o setor solicitante.", "error");
    return;
  }
  if (!orderNumber) {
    showToast("Por favor, digite o número do pedido.", "error");
    return;
  }

  openConfirmationModal();
}

function openConfirmationModal() {
  const modal = document.getElementById('confirmWithdrawalModal');
  const dateInput = document.getElementById('confirmPagoEm');
  const passwordInput = document.getElementById('confirmPassword');
  const errorMsg = document.getElementById('confirmPasswordError');

  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  dateInput.value = `${y}-${m}-${d}`;

  passwordInput.value = '';
  errorMsg.classList.add('hidden');
  renderConfirmWithdrawalItemsList();
  modal.classList.remove('hidden');
  passwordInput.focus();
}

function closeConfirmationModal() {
  document.getElementById('confirmWithdrawalModal').classList.add('hidden');
}

/**
 * Renderiza, dentro do modal de confirmação, a lista de itens da retirada
 * junto com o quanto o setor ainda tem disponível para retirar dentro da
 * média mensal — permitindo ao responsável pela aprovação diminuir, aumentar
 * ou remover itens antes de liberar com a senha.
 */
function renderConfirmWithdrawalItemsList() {
  const container = document.getElementById('confirmWithdrawalItemsList');
  container.innerHTML = '';

  const setor = document.getElementById('formSector').value;
  const limiteInfo = computeConsumoLimiteForSector(setor);

  selectedItemsDetails.forEach((details, name) => {
    const row = document.createElement('div');
    row.className = 'confirm-item-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'confirm-item-name';
    nameEl.textContent = name;
    nameEl.title = name;
    row.appendChild(nameEl);

    const qtyWrapper = document.createElement('div');
    qtyWrapper.className = 'confirm-item-qty-wrapper';

    const qtyControl = document.createElement('div');
    qtyControl.className = 'quantity-control';

    const btnMinus = document.createElement('button');
    btnMinus.type = 'button';
    btnMinus.className = 'quantity-btn';
    btnMinus.textContent = '−';
    btnMinus.onclick = () => {
      const input = qtyControl.querySelector('input');
      let val = parseInt(input.value, 10) || 1;
      if (val > 1) {
        val--;
        input.value = val;
        updateItemQty(name, val);
        renderSelectedItemsRows();
      }
    };

    const inputQty = document.createElement('input');
    inputQty.type = 'number';
    inputQty.className = 'quantity-input';
    inputQty.value = details.qtd;
    inputQty.min = 1;
    inputQty.onchange = (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      e.target.value = val;
      updateItemQty(name, val);
      renderSelectedItemsRows();
    };

    const btnPlus = document.createElement('button');
    btnPlus.type = 'button';
    btnPlus.className = 'quantity-btn';
    btnPlus.textContent = '+';
    btnPlus.onclick = () => {
      const input = qtyControl.querySelector('input');
      let val = parseInt(input.value, 10) || 1;
      val++;
      input.value = val;
      updateItemQty(name, val);
      renderSelectedItemsRows();
    };

    qtyControl.appendChild(btnMinus);
    qtyControl.appendChild(inputQty);
    qtyControl.appendChild(btnPlus);
    qtyWrapper.appendChild(qtyControl);

    const unitLabel = document.createElement('span');
    unitLabel.className = 'confirm-item-qty-unit';
    unitLabel.textContent = details.un;
    qtyWrapper.appendChild(unitLabel);

    row.appendChild(qtyWrapper);

    const availableCell = document.createElement('div');
    availableCell.className = 'confirm-item-available';
    const info = limiteInfo[name];
    if (info) {
      const exceeds = details.qtd > info.remaining;
      availableCell.style.color = exceeds ? 'var(--color-danger)' : 'var(--color-success)';
      availableCell.textContent = formatDataLabelValue(info.remaining);
    } else {
      availableCell.style.color = 'var(--text-muted)';
      availableCell.textContent = 'Sem histórico';
    }
    row.appendChild(availableCell);

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'selected-item-delete-btn';
    btnDelete.title = 'Remover item';
    btnDelete.innerHTML = `
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
      </svg>
    `;
    btnDelete.addEventListener('click', () => {
      removeWithdrawalItem(name);

      if (selectedItemsDetails.size === 0) {
        closeConfirmationModal();
        showToast("Todos os itens foram removidos. Retirada cancelada.", "warning");
        return;
      }

      renderConfirmWithdrawalItemsList();
    });
    row.appendChild(btnDelete);

    container.appendChild(row);
  });
}

function handleConfirmWithdrawalPassword() {
  const dateInput = document.getElementById('confirmPagoEm');
  const passwordInput = document.getElementById('confirmPassword');
  const errorMsg = document.getElementById('confirmPasswordError');

  if (selectedItemsDetails.size === 0) {
    closeConfirmationModal();
    return;
  }

  if (!dateInput.value) {
    showToast("Por favor, informe a data de pagamento.", "error");
    return;
  }

  if (passwordInput.value !== RELEASE_PASSWORD) {
    errorMsg.classList.remove('hidden');
    passwordInput.value = '';
    passwordInput.focus();
    return;
  }

  errorMsg.classList.add('hidden');

  // Converte a data do input (YYYY-MM-DD) para o formato DD/MM/YY usado na planilha
  const [year, month, day] = dateInput.value.split('-');
  const pagoEmStr = `${day}/${month}/${year.substring(2)}`;

  closeConfirmationModal();
  submitWithdrawalForm(pagoEmStr);
}

async function submitWithdrawalForm(pagoEmStr) {
  const sector = document.getElementById('formSector').value;
  const orderNumber = document.getElementById('formOrderNumber').value.trim();

  // Prepara registros para salvar
  const newWithdrawals = [];
  const today = new Date();

  // Formata data como DD/MM/YY
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const yearShort = String(today.getFullYear()).substring(2);
  const formattedDataStr = `${day}/${month}/${yearShort}`;

  [...selectedItemsDetails.entries()].forEach(([name, details], index) => {
    // Procura por preço médio no histórico para herdar
    const match = rawData.find(item => item.produto === name);
    const avgPrice = match ? match.precoMedio : 0;

    newWithdrawals.push({
      produto: name,
      qtd: details.qtd,
      un: details.un,
      data: today,
      dataStr: formattedDataStr,
      setor: sector,
      pedido: orderNumber,
      observacao: "Retirada manual",
      pagoEm: pagoEmStr,
      mes: today.getMonth() + 1,
      categoria: selectedCategory,
      precoMedio: avgPrice,
      // O tempo de retirada só vai na primeira linha do pedido (coluna L na planilha)
      tempoRetiradaMinutos: index === 0 ? withdrawalElapsedMinutes : ''
    });
  });

  // Se SCRIPT_URL estiver configurada, tenta enviar para o Google Sheets
  if (SCRIPT_URL && SCRIPT_URL.trim() !== "") {
    showLoading(true);
    let insufficientStock = false;
    try {
      // Envia os dados como JSON para o Google Apps Script Web App
      const response = await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Content-Type': 'text/plain', // Evita requisição preflight complexa em alguns navegadores/servidores
        },
        body: JSON.stringify({ tipo: 'retirada', items: newWithdrawals })
      });

      const resData = await response.json();
      if (resData && resData.status === 'success') {
        // Salva no LocalStorage como cache local temporário até o CSV atualizar
        saveLocalWithdrawal(newWithdrawals);
        showToast(`${newWithdrawals.length} itens registrados com sucesso no Google Sheets!`, "success");
      } else if (resData && resData.type === 'estoque_insuficiente') {
        // Quantidade solicitada excede o estoque: não salva nada, mantém o formulário aberto
        insufficientStock = true;
        showInsufficientStockModal(resData.details || []);
      } else {
        throw new Error(resData.message || "Erro desconhecido retornado pelo script.");
      }
    } catch (error) {
      console.error("Erro ao salvar no Google Sheets:", error);
      // Em caso de erro, salva localmente e avisa o usuário
      saveLocalWithdrawal(newWithdrawals);
      showToast("Erro ao conectar com Google Sheets. A retirada foi salva localmente.", "warning");
    } finally {
      showLoading(false);
    }

    if (insufficientStock) {
      // Mantém o usuário na tela do formulário para ajustar as quantidades
      return;
    }
  } else {
    // Sem URL configurada: salva localmente com aviso
    saveLocalWithdrawal(newWithdrawals);
    showToast("Salvo localmente! (Configure a SCRIPT_URL para enviar à planilha automaticamente)", "warning");
  }

  // Atualiza os dados locais (mesclando novos dados)
  fetchDashboardData();

  // Redireciona para o Dashboard
  switchTab('dashboard');
}

function resetWithdrawalForm() {
  selectedItemsDetails.clear();
  document.getElementById('itemsDropdownSearch').value = '';
  document.getElementById('formOrderNumber').value = '';
  document.getElementById('formSector').value = '';
  document.getElementById('selectedItemsRowsContainer').classList.add('hidden');
  updateMultiselectLabel();
  resetWithdrawalTimer();
}

// --- CRONÔMETRO DE TEMPO DE RETIRADA ---

function formatElapsedTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function getWithdrawalTimerElapsedMs() {
  let elapsed = withdrawalTimerAccumulatedMs;
  if (withdrawalTimerState === 'running' && withdrawalTimerStartTimestamp) {
    elapsed += Date.now() - withdrawalTimerStartTimestamp;
  }
  return elapsed;
}

function updateWithdrawalTimerDisplay() {
  document.getElementById('withdrawalTimerDisplay').textContent = formatElapsedTime(getWithdrawalTimerElapsedMs());
}

function startWithdrawalTimerTick() {
  stopWithdrawalTimerTick();
  withdrawalTimerIntervalId = setInterval(updateWithdrawalTimerDisplay, 1000);
}

function stopWithdrawalTimerTick() {
  if (withdrawalTimerIntervalId) {
    clearInterval(withdrawalTimerIntervalId);
    withdrawalTimerIntervalId = null;
  }
}

function updateTimerButtonsVisibility() {
  document.getElementById('btnTimerStart').classList.toggle('hidden', withdrawalTimerState !== 'idle');
  document.getElementById('btnTimerPause').classList.toggle('hidden', withdrawalTimerState !== 'running');
  document.getElementById('btnTimerResume').classList.toggle('hidden', withdrawalTimerState !== 'paused');
  document.getElementById('btnTimerFinish').classList.toggle('hidden', !(withdrawalTimerState === 'running' || withdrawalTimerState === 'paused'));
  document.getElementById('btnTimerReset').classList.toggle('hidden', withdrawalTimerState !== 'finished');
}

function isWithdrawalTimeCaptured() {
  return withdrawalElapsedMinutes !== null && withdrawalElapsedMinutes !== undefined;
}

function updateWithdrawalFormLockState() {
  const captured = isWithdrawalTimeCaptured();

  document.getElementById('withdrawalLockableSection').classList.toggle('form-locked', !captured);
  document.getElementById('btnSelectItems').disabled = !captured;
  document.getElementById('formSector').disabled = !captured;
  document.getElementById('formOrderNumber').disabled = !captured;
  document.getElementById('btnSubmitWithdrawal').disabled = !captured;

  const statusEl = document.getElementById('withdrawalTimerStatus');
  const statusValueEl = document.getElementById('withdrawalTimerStatusValue');
  if (captured) {
    statusValueEl.textContent = `${withdrawalElapsedMinutes} min`;
    statusEl.classList.remove('hidden');
  } else {
    statusEl.classList.add('hidden');
  }
}

// Trava o outro método de registro de tempo para não haver conflito entre os dois
function syncTimerAndManualExclusivity() {
  const manualInput = document.getElementById('formManualTime');
  const manualHasValue = manualInput.value.trim() !== '';
  const timerInUse = withdrawalTimerState !== 'idle';

  manualInput.disabled = timerInUse;

  ['btnTimerStart', 'btnTimerPause', 'btnTimerResume', 'btnTimerFinish', 'btnTimerReset'].forEach(id => {
    document.getElementById(id).disabled = manualHasValue;
  });
}

function handleTimerStart() {
  withdrawalTimerState = 'running';
  withdrawalTimerStartTimestamp = Date.now();
  startWithdrawalTimerTick();
  updateWithdrawalTimerDisplay();
  updateTimerButtonsVisibility();
  syncTimerAndManualExclusivity();
}

function handleTimerPause() {
  withdrawalTimerAccumulatedMs = getWithdrawalTimerElapsedMs();
  withdrawalTimerStartTimestamp = null;
  withdrawalTimerState = 'paused';
  stopWithdrawalTimerTick();
  updateWithdrawalTimerDisplay();
  updateTimerButtonsVisibility();
}

function handleTimerResume() {
  withdrawalTimerState = 'running';
  withdrawalTimerStartTimestamp = Date.now();
  startWithdrawalTimerTick();
  updateTimerButtonsVisibility();
}

function handleTimerFinish() {
  withdrawalTimerAccumulatedMs = getWithdrawalTimerElapsedMs();
  withdrawalTimerStartTimestamp = null;
  withdrawalTimerState = 'finished';
  stopWithdrawalTimerTick();
  updateWithdrawalTimerDisplay();

  withdrawalElapsedMinutes = Math.max(Math.round(withdrawalTimerAccumulatedMs / 60000), 0);

  updateTimerButtonsVisibility();
  updateWithdrawalFormLockState();
}

function handleTimerReset() {
  withdrawalTimerState = 'idle';
  withdrawalTimerAccumulatedMs = 0;
  withdrawalTimerStartTimestamp = null;
  withdrawalElapsedMinutes = null;
  stopWithdrawalTimerTick();
  updateWithdrawalTimerDisplay();
  updateTimerButtonsVisibility();
  syncTimerAndManualExclusivity();
  updateWithdrawalFormLockState();
}

function handleManualTimeInput(e) {
  const raw = e.target.value.trim();
  const val = parseInt(raw, 10);

  if (raw !== '' && !isNaN(val) && val >= 0) {
    withdrawalElapsedMinutes = val;
  } else if (withdrawalTimerState !== 'finished') {
    withdrawalElapsedMinutes = null;
  }

  syncTimerAndManualExclusivity();
  updateWithdrawalFormLockState();
}

function resetWithdrawalTimer() {
  stopWithdrawalTimerTick();
  withdrawalTimerState = 'idle';
  withdrawalTimerStartTimestamp = null;
  withdrawalTimerAccumulatedMs = 0;
  withdrawalElapsedMinutes = null;

  document.getElementById('withdrawalTimerDisplay').textContent = '00:00:00';
  document.getElementById('formManualTime').value = '';
  document.getElementById('formManualTime').disabled = false;

  updateTimerButtonsVisibility();
  syncTimerAndManualExclusivity();
  updateWithdrawalFormLockState();
}

function showInsufficientStockModal(details) {
  const modal = document.getElementById('insufficientStockModal');
  const list = document.getElementById('insufficientStockList');
  list.innerHTML = '';

  (details || []).forEach(item => {
    const row = document.createElement('div');
    row.className = 'insufficient-stock-item';
    row.innerHTML = `
      <strong>${item.produto}</strong>
      <span>Disponível: ${formatDataLabelValue(item.disponivel)} · Solicitado: ${formatDataLabelValue(item.solicitado)}</span>
    `;
    list.appendChild(row);
  });

  modal.classList.remove('hidden');
}

function closeInsufficientStockModal() {
  document.getElementById('insufficientStockModal').classList.add('hidden');
}

// --- MÓDULO DE ENTRADA DE MATERIAL (FORMULÁRIO E LÓGICA) ---

function initializeEntradaModule() {
  const btnSelect = document.getElementById('btnSelectItemsEntrada');
  const dropdown = document.getElementById('itemsDropdownEntrada');

  btnSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  // Fecha dropdown ao clicar fora
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== btnSelect && !btnSelect.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  // Input de Busca no dropdown
  document.getElementById('itemsDropdownSearchEntrada').addEventListener('input', (e) => {
    renderMultiselectOptionsEntrada(e.target.value);
  });

  // Botões de Cancelar/Confirmar
  document.getElementById('btnCancelEntrada').addEventListener('click', () => {
    switchTab('dashboard');
  });

  document.getElementById('btnSubmitEntrada').addEventListener('click', handleEntradaFormSubmit);

  // Modal de confirmação (senha de liberação)
  document.getElementById('btnCancelConfirmEntradaModal').addEventListener('click', closeEntradaConfirmationModal);
  document.getElementById('btnConfirmEntradaPassword').addEventListener('click', handleConfirmEntradaPassword);

  document.getElementById('confirmEntradaPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirmEntradaPassword();
    }
  });

  // Fecha o modal ao clicar fora do card
  document.getElementById('confirmEntradaModal').addEventListener('click', (e) => {
    if (e.target.id === 'confirmEntradaModal') {
      closeEntradaConfirmationModal();
    }
  });

  // Modal de categoria para material novo
  document.getElementById('btnCancelNewMaterialCategory').addEventListener('click', closeNewMaterialCategoryModal);
  document.getElementById('btnConfirmNewMaterialCategory').addEventListener('click', confirmNewMaterialCategory);
  document.getElementById('newMaterialCategoryModal').addEventListener('click', (e) => {
    if (e.target.id === 'newMaterialCategoryModal') {
      closeNewMaterialCategoryModal();
    }
  });
}

async function openEntradaForm() {
  selectedEntradaItemsDetails.clear();
  entradaCustomCategories = {};
  document.getElementById('itemsDropdownSearchEntrada').value = '';

  // Busca os materiais já cadastrados na aba "Estoque" (inclusive os que
  // nunca foram retirados, então não apareceriam só com os dados do Registro)
  // para que materiais novos cadastrados numa entrada anterior já apareçam
  // na lista suspensa.
  await fetchStockLevels();

  const registroProducts = rawData.map(item => item.produto);
  const estoqueProducts = stockData.map(item => item.produto);
  uniqueProductNamesForEntrada = [...new Set([...registroProducts, ...estoqueProducts])].sort();

  renderMultiselectOptionsEntrada();
  updateMultiselectLabelEntrada();
  renderSelectedItemsRowsEntrada();
}

function renderMultiselectOptionsEntrada(searchQuery = '') {
  const container = document.getElementById('itemsOptionsContainerEntrada');
  container.innerHTML = '';

  const trimmedQuery = searchQuery.trim();
  const filtered = uniqueProductNamesForEntrada.filter(name =>
    name.toLowerCase().includes(trimmedQuery.toLowerCase())
  );

  // Se o texto digitado não corresponder exatamente a nenhum produto já
  // existente, oferece a opção de cadastrar esse material como novo.
  const exactMatchExists = uniqueProductNamesForEntrada.some(name =>
    name.toLowerCase() === trimmedQuery.toLowerCase()
  );

  if (trimmedQuery && !exactMatchExists) {
    const addDiv = document.createElement('div');
    addDiv.className = 'multiselect-option multiselect-option-add';
    addDiv.innerHTML = `<span>+ Adicionar novo material: "${trimmedQuery}"</span>`;
    addDiv.addEventListener('click', () => {
      openNewMaterialCategoryModal(trimmedQuery);
    });
    container.appendChild(addDiv);
  }

  if (filtered.length === 0) {
    if (!trimmedQuery) {
      container.innerHTML += `<div style="padding: 0.5rem 1rem; color: var(--text-muted); font-size: 0.875rem;">Nenhum produto encontrado</div>`;
    }
    return;
  }

  filtered.forEach(name => {
    const div = document.createElement('div');
    div.className = 'multiselect-option';

    const isChecked = selectedEntradaItemsDetails.has(name);
    const safeId = `chk-entrada-${name.replace(/[^a-zA-Z0-9]/g, '_')}`;

    div.innerHTML = `
      <label style="display:flex;align-items:center;gap:0.5rem;width:100%;cursor:pointer;user-select:none;" for="${safeId}">
        <input type="checkbox" id="${safeId}" ${isChecked ? 'checked' : ''}>
        <span style="flex-grow:1;">${name}</span>
      </label>
    `;

    div.querySelector('input').addEventListener('change', (e) => {
      toggleItemSelectionEntrada(name, e.target.checked);
    });

    container.appendChild(div);
  });
}

function openNewMaterialCategoryModal(name) {
  pendingCustomEntradaProductName = name;
  document.getElementById('newMaterialCategoryProductName').textContent = name;
  document.getElementById('newMaterialCategorySelect').value = '';
  document.getElementById('newMaterialCategoryModal').classList.remove('hidden');
}

function closeNewMaterialCategoryModal() {
  pendingCustomEntradaProductName = '';
  document.getElementById('newMaterialCategoryModal').classList.add('hidden');
}

function confirmNewMaterialCategory() {
  const categoria = document.getElementById('newMaterialCategorySelect').value;
  const name = pendingCustomEntradaProductName;
  closeNewMaterialCategoryModal();
  addCustomEntradaProduct(name, categoria);
}

function addCustomEntradaProduct(name, categoria) {
  const trimmedName = name.trim();
  if (!trimmedName) return;

  const alreadyExists = uniqueProductNamesForEntrada.some(existing =>
    existing.toLowerCase() === trimmedName.toLowerCase()
  );

  if (!alreadyExists) {
    uniqueProductNamesForEntrada.push(trimmedName);
    uniqueProductNamesForEntrada.sort();
  }

  if (categoria) {
    entradaCustomCategories[trimmedName] = categoria;
  }

  toggleItemSelectionEntrada(trimmedName, true);

  const searchInput = document.getElementById('itemsDropdownSearchEntrada');
  searchInput.value = '';
  renderMultiselectOptionsEntrada();
}

function toggleItemSelectionEntrada(name, isChecked) {
  if (isChecked) {
    // Busca a última unidade usada desse produto para sugerir por padrão
    const match = rawData.find(item => item.produto === name);
    const defaultUnit = match ? match.un : 'un';

    selectedEntradaItemsDetails.set(name, {
      qtd: 1,
      un: defaultUnit,
      categoria: entradaCustomCategories[name] || ''
    });
  } else {
    selectedEntradaItemsDetails.delete(name);
  }

  updateMultiselectLabelEntrada();
  renderSelectedItemsRowsEntrada();
}

function updateMultiselectLabelEntrada() {
  const label = document.getElementById('multiselectLabelEntrada');
  const count = selectedEntradaItemsDetails.size;

  if (count === 0) {
    label.textContent = "Selecione os produtos...";
    label.style.color = 'var(--text-muted)';
  } else if (count === 1) {
    label.textContent = `${count} produto selecionado`;
    label.style.color = 'var(--text-primary)';
  } else {
    label.textContent = `${count} produtos selecionados`;
    label.style.color = 'var(--text-primary)';
  }
}

function renderSelectedItemsRowsEntrada() {
  const container = document.getElementById('selectedItemsRowsContainerEntrada');
  container.innerHTML = '';

  if (selectedEntradaItemsDetails.size === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  selectedEntradaItemsDetails.forEach((details, name) => {
    const row = document.createElement('div');
    row.className = 'selected-item-row selected-item-row--with-delete';

    const nameEl = document.createElement('div');
    nameEl.className = 'selected-item-name';
    nameEl.textContent = name;
    nameEl.title = name;
    row.appendChild(nameEl);

    const qtyControl = document.createElement('div');
    qtyControl.className = 'quantity-control';

    const btnMinus = document.createElement('button');
    btnMinus.className = 'quantity-btn';
    btnMinus.textContent = '−';
    btnMinus.onclick = () => {
      const input = qtyControl.querySelector('input');
      let val = parseInt(input.value, 10) || 1;
      if (val > 1) {
        val--;
        input.value = val;
        updateEntradaItemQty(name, val);
      }
    };

    const inputQty = document.createElement('input');
    inputQty.type = 'number';
    inputQty.className = 'quantity-input';
    inputQty.value = details.qtd;
    inputQty.min = 1;
    inputQty.onchange = (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      e.target.value = val;
      updateEntradaItemQty(name, val);
    };

    const btnPlus = document.createElement('button');
    btnPlus.className = 'quantity-btn';
    btnPlus.textContent = '+';
    btnPlus.onclick = () => {
      const input = qtyControl.querySelector('input');
      let val = parseInt(input.value, 10) || 1;
      val++;
      input.value = val;
      updateEntradaItemQty(name, val);
    };

    qtyControl.appendChild(btnMinus);
    qtyControl.appendChild(inputQty);
    qtyControl.appendChild(btnPlus);
    row.appendChild(qtyControl);

    const unitSelect = document.createElement('select');
    unitSelect.style.width = '100%';
    unitSelect.style.padding = '0.4rem';
    unitSelect.style.fontSize = '0.875rem';
    unitSelect.style.borderRadius = 'var(--radius-sm)';
    unitSelect.style.border = '1px solid var(--border-color)';
    unitSelect.style.fontFamily = 'var(--font-family)';

    UNIT_OPTIONS.forEach(unit => {
      const opt = document.createElement('option');
      opt.value = unit;
      opt.textContent = unit;
      if (unit === details.un) opt.selected = true;
      unitSelect.appendChild(opt);
    });

    unitSelect.onchange = (e) => {
      updateEntradaItemUnit(name, e.target.value);
    };

    row.appendChild(unitSelect);

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'selected-item-delete-btn';
    btnDelete.title = 'Remover item';
    btnDelete.innerHTML = `
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
      </svg>
    `;
    btnDelete.addEventListener('click', () => {
      removeEntradaItem(name);
    });
    row.appendChild(btnDelete);

    container.appendChild(row);
  });
}

function removeEntradaItem(name) {
  selectedEntradaItemsDetails.delete(name);
  updateMultiselectLabelEntrada();
  renderSelectedItemsRowsEntrada();
  renderMultiselectOptionsEntrada(document.getElementById('itemsDropdownSearchEntrada').value);
}

function updateEntradaItemQty(name, qty) {
  if (selectedEntradaItemsDetails.has(name)) {
    selectedEntradaItemsDetails.get(name).qtd = qty;
  }
}

function updateEntradaItemUnit(name, unit) {
  if (selectedEntradaItemsDetails.has(name)) {
    selectedEntradaItemsDetails.get(name).un = unit;
  }
}

function handleEntradaFormSubmit() {
  if (selectedEntradaItemsDetails.size === 0) {
    showToast("Por favor, selecione pelo menos um produto.", "error");
    return;
  }

  openEntradaConfirmationModal();
}

function openEntradaConfirmationModal() {
  const modal = document.getElementById('confirmEntradaModal');
  const passwordInput = document.getElementById('confirmEntradaPassword');
  const errorMsg = document.getElementById('confirmEntradaPasswordError');

  passwordInput.value = '';
  errorMsg.classList.add('hidden');
  modal.classList.remove('hidden');
  passwordInput.focus();
}

function closeEntradaConfirmationModal() {
  document.getElementById('confirmEntradaModal').classList.add('hidden');
}

function handleConfirmEntradaPassword() {
  const passwordInput = document.getElementById('confirmEntradaPassword');
  const errorMsg = document.getElementById('confirmEntradaPasswordError');

  if (passwordInput.value !== RELEASE_PASSWORD) {
    errorMsg.classList.remove('hidden');
    passwordInput.value = '';
    passwordInput.focus();
    return;
  }

  errorMsg.classList.add('hidden');
  closeEntradaConfirmationModal();
  submitEntradaForm();
}

async function submitEntradaForm() {
  const newEntries = [];

  selectedEntradaItemsDetails.forEach((details, name) => {
    newEntries.push({
      produto: name,
      qtd: details.qtd,
      un: details.un,
      categoria: details.categoria || ''
    });
  });

  if (!SCRIPT_URL || SCRIPT_URL.trim() === "") {
    showToast("Configure a SCRIPT_URL para enviar a entrada à planilha.", "warning");
    return;
  }

  showLoading(true);
  try {
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ tipo: 'entrada', items: newEntries })
    });

    const resData = await response.json();
    if (resData && resData.status === 'success') {
      showToast(`${newEntries.length} itens registrados com sucesso no estoque!`, "success");
    } else {
      throw new Error(resData.message || "Erro desconhecido retornado pelo script.");
    }
  } catch (error) {
    console.error("Erro ao salvar entrada no Google Sheets:", error);
    showToast("Erro ao conectar com Google Sheets. A entrada não foi registrada.", "error");
    showLoading(false);
    return;
  } finally {
    showLoading(false);
  }

  resetEntradaForm();
  switchTab('dashboard');
}

function resetEntradaForm() {
  selectedEntradaItemsDetails.clear();
  document.getElementById('itemsDropdownSearchEntrada').value = '';
  document.getElementById('selectedItemsRowsContainerEntrada').classList.add('hidden');
  updateMultiselectLabelEntrada();
}

// --- MÓDULO DE CONSULTA DE ESTOQUE ---

function initializeEstoqueModule() {
  document.querySelectorAll('#estoqueCategorySelection .category-card').forEach(card => {
    card.addEventListener('click', () => {
      const category = card.getAttribute('data-category');
      openEstoqueCategory(category);
    });
  });

  document.getElementById('btnGoBackEstoqueCategories').addEventListener('click', () => {
    showEstoqueScreen('categories');
  });

  document.getElementById('estoqueSearchInput').addEventListener('input', (e) => {
    estoqueSearchQuery = e.target.value;
    renderEstoqueTable();
  });
}

function showEstoqueScreen(screen) {
  const categorySelection = document.getElementById('estoqueCategorySelection');
  const listSection = document.getElementById('estoqueListSection');

  if (screen === 'categories') {
    categorySelection.classList.remove('hidden');
    listSection.classList.add('hidden');
    currentEstoqueCategory = "";
    estoqueSearchQuery = "";
    document.getElementById('estoqueSearchInput').value = '';
  } else if (screen === 'list') {
    categorySelection.classList.add('hidden');
    listSection.classList.remove('hidden');
  }
}

function openEstoqueCategory(category) {
  currentEstoqueCategory = category;
  document.getElementById('selectedEstoqueCategoryTitle').textContent = category;
  estoqueSearchQuery = '';
  document.getElementById('estoqueSearchInput').value = '';

  renderEstoqueTable();
  showEstoqueScreen('list');
}

function getCategoryForProduct(productName) {
  const stockMatch = stockData.find(item => item.produto === productName);
  if (stockMatch && stockMatch.categoria) return stockMatch.categoria;

  const match = rawData.find(item => item.produto === productName);
  return match ? match.categoria : '';
}

function renderEstoqueTable() {
  const tbody = document.getElementById('estoqueTableBody');
  tbody.innerHTML = '';

  let items = stockData.filter(item =>
    getCategoryForProduct(item.produto).toLowerCase() === currentEstoqueCategory.toLowerCase()
  );

  if (estoqueSearchQuery) {
    const q = estoqueSearchQuery.toLowerCase();
    items = items.filter(item => item.produto.toLowerCase().includes(q));
  }

  items = items.slice().sort((a, b) => a.produto.localeCompare(b.produto));

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 2rem;">Nenhum produto encontrado nesta categoria</td></tr>`;
    return;
  }

  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 600; color: var(--text-primary);">${item.produto}</td>
      <td style="color: var(--text-secondary);">${item.un}</td>
      <td style="font-weight: 500;">${formatDataLabelValue(item.total)}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function fetchStockLevels() {
  if (!SCRIPT_URL || SCRIPT_URL.trim() === "") {
    showToast("Configure a SCRIPT_URL para consultar o estoque.", "warning");
    return;
  }

  showLoading(true);
  try {
    const response = await fetch(`${SCRIPT_URL}?action=estoque&t=${new Date().getTime()}`, {
      method: 'GET',
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Falha na requisição HTTP: ${response.status} ${response.statusText}`);
    }

    const resData = await response.json();
    if (resData && resData.status === 'success' && Array.isArray(resData.items)) {
      stockData = resData.items;
    } else {
      throw new Error(resData.message || "Erro desconhecido ao consultar o estoque.");
    }
  } catch (error) {
    console.error("Erro ao consultar níveis de estoque:", error);
    showToast("Erro ao consultar o estoque na planilha.", "error");
    stockData = [];
  } finally {
    showLoading(false);
  }

  // Se já houver uma categoria aberta, atualiza a tabela com os dados recém-carregados
  if (currentEstoqueCategory) {
    renderEstoqueTable();
  }
}

// --- UTILS DE ELEMENTOS DA UI ---

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  const btn = document.getElementById('btnRefresh');

  if (show) {
    overlay.classList.remove('hidden');
    if (btn) btn.classList.add('loading');
    if (btn) btn.disabled = true;
  } else {
    overlay.classList.add('hidden');
    if (btn) btn.classList.remove('loading');
    if (btn) btn.disabled = false;
  }
}

function showError(message) {
  const banner = document.getElementById('errorBanner');
  const msgEl = document.getElementById('errorMessage');
  if (msgEl) msgEl.textContent = message;
  if (banner) banner.style.display = 'flex';
}

function hideError() {
  const banner = document.getElementById('errorBanner');
  if (banner) banner.style.display = 'none';
}

function updateLastUpdatedTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('pt-BR');
  const lastUpdateContainer = document.getElementById('lastUpdateContainer');
  if (lastUpdateContainer) lastUpdateContainer.textContent = `Última atualização: ${timeStr}`;
}

function showToast(message, type = "success") {
  const toast = document.getElementById('toastNotification');
  const icon = document.getElementById('toastIcon');
  const text = document.getElementById('toastText');

  text.textContent = message;
  toast.className = `toast toast-${type} show`;

  if (type === 'success') {
    icon.innerHTML = `
      <svg style="width:20px;height:20px;color:#10b981" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
    `;
  } else if (type === 'warning') {
    icon.innerHTML = `
      <svg style="width:20px;height:20px;color:#f59e0b" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
      </svg>
    `;
  } else {
    icon.innerHTML = `
      <svg style="width:20px;height:20px;color:#ef4444" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
    `;
  }

  // Remove o toast após 4 segundos
  setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

// --- CONFIGURAÇÃO DE LISTENERS ---

function initEventListeners() {
  // Listeners do menu lateral
  document.getElementById('menuDashboard').addEventListener('click', () => switchTab('dashboard'));
  document.getElementById('menuRetirada').addEventListener('click', () => switchTab('retirada'));
  document.getElementById('menuEntrada').addEventListener('click', () => switchTab('entrada'));
  document.getElementById('menuEstoque').addEventListener('click', () => switchTab('estoque'));

  // Listener do botão de Atualizar
  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', fetchDashboardData);
  }

  // Listeners dos filtros
  document.getElementById('filterDateStart').addEventListener('change', applyFilters);
  document.getElementById('filterDateEnd').addEventListener('change', applyFilters);
  document.getElementById('filterMonth').addEventListener('change', applyFilters);
  document.getElementById('filterSector').addEventListener('change', applyFilters);
  document.getElementById('filterCategory').addEventListener('change', applyFilters);

  // Listener do filtro de Consumo Limite por Setor
  document.getElementById('consumoLimiteSetorFilter').addEventListener('change', renderConsumoLimiteSetor);
  document.getElementById('btnExportConsumoLimitePDF').addEventListener('click', exportConsumoLimiteSetorPDF);
}

// --- TELA DE ACESSO (SENHA) ---

const ACCESS_GATE_PASSWORD = "diretoria321";
const ACCESS_GATE_GRANTED_KEY = "almoxarifado_access_granted";

function initAccessGate() {
  const gate = document.getElementById('accessGateScreen');
  const card = gate.querySelector('.access-gate-card');
  const passwordInput = document.getElementById('accessGatePassword');
  const errorMsg = document.getElementById('accessGateError');
  const submitBtn = document.getElementById('btnAccessGateSubmit');
  const toggleBtn = document.getElementById('btnToggleAccessGatePassword');

  // Se o acesso já foi liberado antes neste navegador, pula direto para o app.
  if (localStorage.getItem(ACCESS_GATE_GRANTED_KEY) === '1') {
    gate.remove();
    initApp();
    return;
  }

  function attemptAccess() {
    if (passwordInput.value === ACCESS_GATE_PASSWORD) {
      errorMsg.classList.add('hidden');
      localStorage.setItem(ACCESS_GATE_GRANTED_KEY, '1');
      gate.classList.add('access-gate-unlocked');
      setTimeout(() => gate.remove(), 400);
      initApp();
    } else {
      errorMsg.classList.remove('hidden');
      passwordInput.value = '';
      passwordInput.focus();
      card.classList.remove('shake');
      // Força o reinício da animação mesmo se disparada duas vezes seguidas
      void card.offsetWidth;
      card.classList.add('shake');
    }
  }

  submitBtn.addEventListener('click', attemptAccess);

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptAccess();
    }
  });

  toggleBtn.addEventListener('click', () => {
    passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.focus();
  });

  passwordInput.focus();
}

// --- INICIALIZAÇÃO ---

function initApp() {
  initEventListeners();
  initializeWithdrawalModule();
  initializeEntradaModule();
  initializeEstoqueModule();
  initSidebarToggle();
  fetchDashboardData();
}

document.addEventListener('DOMContentLoaded', () => {
  initAccessGate();
});
