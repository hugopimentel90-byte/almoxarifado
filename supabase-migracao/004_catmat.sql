-- Dashboard Almoxarifado (BFLa) — Parte 2 do Ponto de Compra: cache local do
-- catálogo de PDMs do CATMAT (Padrão Descritivo de Materiais), usado pelo
-- casamento por descrição quando ATA = Não.
--
-- A API oficial (dadosabertos.compras.gov.br) não tem busca por
-- palavra-chave de verdade — só consulta por código exato ou listagem
-- completa. Por isso baixamos uma vez a lista de PDMs ativos (~15 mil,
-- bem menor que os ~250 mil itens do catálogo completo) e guardamos aqui,
-- pra fazer a comparação de texto localmente no navegador (ver
-- normalizarTextoBusca/pontuarSemelhancaTexto em app.js).
--
-- Dado de referência: só leitura pro app (mesmo padrão de RLS das outras
-- tabelas), sem função de escrita — atualizações futuras do catálogo são
-- feitas manualmente (reimportar o CSV), não pelo app.

create table if not exists catmat_pdms (
  codigo_pdm integer primary key,
  nome_pdm text not null,
  codigo_grupo integer,
  nome_grupo text,
  codigo_classe integer,
  nome_classe text,
  atualizado_em timestamptz not null default now()
);
create index if not exists catmat_pdms_nome_idx on catmat_pdms (lower(nome_pdm));

alter table catmat_pdms enable row level security;
create policy "leitura publica" on catmat_pdms for select using (true);
revoke insert, update, delete on catmat_pdms from anon, authenticated;
