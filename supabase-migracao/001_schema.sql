-- Dashboard Almoxarifado (BFLa) — Fase 1 da migração para Supabase
-- Schema das 4 tabelas que substituem as abas da planilha.
-- Sem RLS ainda (isso é decisão da Fase 2, junto com as funções RPC).
-- Rode este arquivo inteiro de uma vez no SQL Editor do Supabase.

create table if not exists estoque (
  id bigint generated always as identity primary key,
  produto text not null,
  un text,
  categoria text,
  codigo_barras text,
  ponto_pedido numeric,
  -- Funde "QTD Atual" (base) + "Entrada 1" do CSV original numa coluna só.
  -- A separação base/entrada só existia por causa do limite de largura da
  -- planilha — no Postgres isso deixa de fazer sentido.
  saldo numeric not null default 0,
  -- Se o item está coberto por alguma ATA de Registro de Preços vigente.
  -- null = ainda não informado. Editável pelo lápis da Consulta de Estoque
  -- e usado como filtro na tela Ponto de Compra (coluna adicionada depois
  -- da Fase 2, ver estoque_editar em 003_funcoes.sql).
  ata boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists estoque_produto_lower_idx on estoque (lower(produto));

create table if not exists registro (
  id bigint generated always as identity primary key,
  produto text not null,
  qtd numeric not null,
  un text,
  data date,
  setor text,
  pedido text,
  observacao text,
  pago_em date,
  mes smallint,
  categoria text,
  preco_medio numeric,
  tempo_retirada_min numeric,
  created_at timestamptz not null default now()
);
create index if not exists registro_produto_idx on registro (lower(produto));
create index if not exists registro_data_idx on registro (data);

create table if not exists liberacao (
  id text primary key,
  setor text,
  titulo text,
  -- Antes chamada "Descricao" — registros criados antes da mudança desta
  -- sessão têm texto livre aqui, não necessariamente um setor de verdade.
  setor_requisitante text,
  nome_arquivo text,
  url_arquivo text,
  status text,
  criado_em timestamptz,
  transmitido_em timestamptz,
  aprovado_encarregado_em timestamptz,
  aprovado_imediato_em timestamptz,
  ultima_acao text,
  itens jsonb not null default '[]'::jsonb,
  -- Itens exatamente como vieram do PDF na criação, nunca mais sobrescritos —
  -- permite detectar se o Encarregado alterou alguma quantidade antes de
  -- aprovar (coluna adicionada depois da Fase 2, ver 003_funcoes.sql).
  itens_originais jsonb not null default '[]'::jsonb,
  registrado_no_estoque_em timestamptz
);
create index if not exists liberacao_status_idx on liberacao (status);

create table if not exists demanda (
  id bigint generated always as identity primary key,
  material text not null,
  ponto_pedido numeric,
  unidade text,
  categoria text,
  descricao_fornecedor text,
  qtd_minima numeric,
  multiplicador numeric,
  valor_unitario numeric,
  catmat text
);
create unique index if not exists demanda_material_lower_idx on demanda (lower(material));
