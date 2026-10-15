-- Dashboard Almoxarifado (BFLa) — Mapeamento em lote com o CATMAT.
--
-- Liga cada produto do Estoque ao catálogo oficial do CATMAT (Grupo,
-- Classe, PDM e descrição de item mais parecida), base pra uma futura ATA
-- de Registro de Preços. Uma linha por produto do Estoque — gerada
-- automaticamente em lote (ver executarMapeamentoCatmatEmLote em app.js,
-- que reaproveita o casamento por palavra de referência já construído na
-- Parte 2 do Ponto de Compra) e depois revisada rapidamente numa fila
-- (aprovar/trocar/sem correspondência).

create table if not exists estoque_catmat_mapeamento (
  id bigint generated always as identity primary key,
  estoque_id bigint not null references estoque(id) on delete cascade,
  produto text not null, -- cópia do nome no momento do mapeamento, pra exibição/histórico
  codigo_grupo integer,
  nome_grupo text,
  codigo_classe integer,
  nome_classe text,
  codigo_pdm integer,
  nome_pdm text,
  codigo_item integer,
  descricao_item text,
  score numeric, -- pontuação do casamento (0 a 1), mostrada como confiança na revisão
  status text not null default 'pendente', -- 'pendente' | 'aprovado' | 'sem_correspondencia'
  atualizado_em timestamptz not null default now()
);
create unique index if not exists estoque_catmat_mapeamento_estoque_id_idx on estoque_catmat_mapeamento (estoque_id);
create index if not exists estoque_catmat_mapeamento_status_idx on estoque_catmat_mapeamento (status);

alter table estoque_catmat_mapeamento enable row level security;
create policy "leitura publica" on estoque_catmat_mapeamento for select using (true);
revoke insert, update, delete on estoque_catmat_mapeamento from anon, authenticated;

-- =====================================================================
-- catmat_mapeamento_salvar: upsert por estoque_id (um registro por
-- produto) — usada tanto pela geração automática em lote (status =
-- 'pendente') quanto pelas ações da fila de revisão (status = 'aprovado'
-- ou 'sem_correspondencia', possivelmente com outro PDM/item escolhido
-- manualmente via "Trocar"). Mesmo padrão de demanda_editar_fornecedor:
-- senha da Diretoria, digitada uma vez por sessão no app.js (não a cada
-- um dos ~1.900 itens), mas validada aqui a cada gravação.
-- =====================================================================
create or replace function catmat_mapeamento_salvar(
  p_estoque_id bigint,
  p_produto text,
  p_codigo_grupo integer,
  p_nome_grupo text,
  p_codigo_classe integer,
  p_nome_classe text,
  p_codigo_pdm integer,
  p_nome_pdm text,
  p_codigo_item integer,
  p_descricao_item text,
  p_score numeric,
  p_status text,
  p_senha text
) returns estoque_catmat_mapeamento
language plpgsql
security definer
set search_path = public
as $$
declare
  v_diretoria_senha constant text := 'diretoria321';
  v_row estoque_catmat_mapeamento;
begin
  if p_senha is distinct from v_diretoria_senha then
    raise exception 'Senha da Diretoria incorreta.';
  end if;
  if p_status not in ('pendente', 'aprovado', 'sem_correspondencia') then
    raise exception 'Status inválido: %', p_status;
  end if;
  if not exists (select 1 from estoque where id = p_estoque_id) then
    raise exception 'Produto do Estoque não encontrado.';
  end if;

  insert into estoque_catmat_mapeamento (
    estoque_id, produto, codigo_grupo, nome_grupo, codigo_classe, nome_classe,
    codigo_pdm, nome_pdm, codigo_item, descricao_item, score, status, atualizado_em
  )
  values (
    p_estoque_id, p_produto, p_codigo_grupo, p_nome_grupo, p_codigo_classe, p_nome_classe,
    p_codigo_pdm, p_nome_pdm, p_codigo_item, p_descricao_item, p_score, p_status, now()
  )
  on conflict (estoque_id) do update
    set produto = excluded.produto,
        codigo_grupo = excluded.codigo_grupo,
        nome_grupo = excluded.nome_grupo,
        codigo_classe = excluded.codigo_classe,
        nome_classe = excluded.nome_classe,
        codigo_pdm = excluded.codigo_pdm,
        nome_pdm = excluded.nome_pdm,
        codigo_item = excluded.codigo_item,
        descricao_item = excluded.descricao_item,
        score = excluded.score,
        status = excluded.status,
        atualizado_em = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function catmat_mapeamento_salvar(bigint, text, integer, text, integer, text, integer, text, integer, text, numeric, text, text) to anon, authenticated;
