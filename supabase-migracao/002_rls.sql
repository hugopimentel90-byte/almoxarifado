-- Dashboard Almoxarifado (BFLa) — Fase 2: ativa RLS de verdade.
-- Mesmo nível de confiança que o site já tem hoje (hoje o SCRIPT_URL/CSV_URL
-- são endpoints públicos sem autenticação própria; quem protege o app é a
-- senha da tela de acesso, não uma permissão por linha do banco) — então
-- liberamos leitura geral e bloqueamos QUALQUER escrita direta nas tabelas.
-- Toda escrita só acontece pelas funções RPC de 003_funcoes.sql, que rodam
-- como "security definer" (ignoram RLS, mas só fazem o que o código delas
-- permite).

alter table estoque enable row level security;
alter table registro enable row level security;
alter table liberacao enable row level security;
alter table demanda enable row level security;

create policy "leitura publica" on estoque for select using (true);
create policy "leitura publica" on registro for select using (true);
create policy "leitura publica" on liberacao for select using (true);
create policy "leitura publica" on demanda for select using (true);

-- Garante que anon/authenticated não têm nenhum privilégio de escrita direto
-- nas tabelas (sem policy de insert/update/delete, PostgREST já bloqueia,
-- mas isso aqui reforça o mesmo bloqueio em qualquer outro acesso SQL).
revoke insert, update, delete on estoque, registro, liberacao, demanda from anon, authenticated;
