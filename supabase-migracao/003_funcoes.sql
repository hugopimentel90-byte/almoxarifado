-- Dashboard Almoxarifado (BFLa) — Fase 2: funções RPC que substituem a
-- lógica de negócio do Code.gs. Todas "security definer": rodam com
-- privilégio de dono, ignorando o RLS das tabelas (que só libera leitura
-- pra anon/authenticated) — por isso são o ÚNICO jeito de escrever nas 4
-- tabelas a partir do app.

-- =====================================================================
-- retirar_material: mesma lógica de handleRetiradaMaterial do Code.gs.
-- Valida saldo suficiente de TODOS os produtos do lote antes de gravar
-- qualquer coisa; se faltar saldo pra algum, nada é gravado.
--
-- items: array de objetos {produto, qtd, un, data (YYYY-MM-DD), setor,
--   pedido, pagoEm (YYYY-MM-DD), mes, categoria, tempoRetiradaMinutos}.
-- =====================================================================
create or replace function retirar_material(items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_insufficient jsonb;
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'Nenhum item informado.';
  end if;

  -- Materializa os itens numa tabela temporária (existe só durante esta
  -- transação) pra poder passar 4 vezes pelos mesmos dados sem reler o
  -- jsonb repetidamente: travar o estoque envolvido, checar saldo, gravar
  -- no Registro na ordem original, e por fim descontar o saldo.
  create temporary table tmp_itens on commit drop as
  select
    ord,
    trim(elem->>'produto') as produto,
    lower(trim(elem->>'produto')) as produto_lower,
    coalesce((elem->>'qtd')::numeric, 0) as qtd,
    elem->>'un' as un,
    nullif(elem->>'data', '')::date as data,
    elem->>'setor' as setor,
    elem->>'pedido' as pedido,
    nullif(elem->>'pagoEm', '')::date as pago_em,
    nullif(elem->>'mes', '')::smallint as mes,
    elem->>'categoria' as categoria,
    nullif(elem->>'tempoRetiradaMinutos', '')::numeric as tempo_retirada_min
  from jsonb_array_elements(items) with ordinality as t(elem, ord)
  where trim(elem->>'produto') <> '';

  -- Tranca (FOR UPDATE) só as linhas de estoque dos produtos deste lote —
  -- outros produtos continuam livres pra outras retiradas/entradas
  -- acontecerem ao mesmo tempo, diferente do LockService global de antes.
  perform 1 from estoque
  where lower(produto) in (select distinct produto_lower from tmp_itens)
  for update;

  -- Checa saldo suficiente por produto (soma de todas as linhas do lote
  -- pro mesmo produto). Produto que não existe na aba Estoque não é
  -- validado aqui — mesmo comportamento de sempre.
  select jsonb_agg(jsonb_build_object(
      'produto', agg.produto_exemplo,
      'disponivel', e.saldo,
      'solicitado', agg.total
    ))
  into v_insufficient
  from (
    select produto_lower, max(produto) as produto_exemplo, sum(qtd) as total
    from tmp_itens
    group by produto_lower
  ) agg
  join estoque e on lower(e.produto) = agg.produto_lower
  where agg.total > e.saldo;

  if v_insufficient is not null and jsonb_array_length(v_insufficient) > 0 then
    raise exception 'Quantidade solicitada excede o estoque disponível.'
      using errcode = 'P0001', detail = v_insufficient::text;
  end if;

  -- Grava no Registro, uma linha por item, na ordem original do lote.
  insert into registro (produto, qtd, un, data, setor, pedido, pago_em, mes, categoria, tempo_retirada_min)
  select produto, qtd, un, data, setor, pedido, pago_em, mes, categoria, tempo_retirada_min
  from tmp_itens
  order by ord;
  get diagnostics v_count = row_count;

  -- Desconta o saldo de cada produto afetado (uma única soma por produto,
  -- cobrindo o caso do mesmo produto aparecer mais de uma vez no lote).
  update estoque e
  set saldo = e.saldo - agg.total, updated_at = now()
  from (select produto_lower, sum(qtd) as total from tmp_itens group by produto_lower) agg
  where lower(e.produto) = agg.produto_lower;

  return jsonb_build_object('count', v_count);
end;
$$;

-- =====================================================================
-- registrar_entrada: mesma lógica de handleEntradaMaterial. Soma a
-- quantidade no saldo do produto (cria o produto se ainda não existir).
-- =====================================================================
create or replace function registrar_entrada(items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  v_produto text;
  v_qtd numeric;
  v_count int := 0;
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'Nenhum item informado.';
  end if;

  for item in select * from jsonb_array_elements(items)
  loop
    v_produto := trim(item->>'produto');
    if v_produto = '' or v_produto is null then continue; end if;
    v_qtd := coalesce((item->>'qtd')::numeric, 0);

    insert into estoque (produto, un, categoria, saldo)
    values (v_produto, item->>'un', nullif(item->>'categoria', ''), v_qtd)
    on conflict (lower(produto)) do update
      set saldo = estoque.saldo + excluded.saldo,
          un = excluded.un,
          categoria = coalesce(excluded.categoria, estoque.categoria),
          updated_at = now();
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('count', v_count);
end;
$$;

-- =====================================================================
-- liberacao_criar: mesma lógica de handleLiberacaoCriar. O upload do PDF
-- no Drive já aconteceu antes, via Apps Script — aqui só recebe o nome e
-- a URL prontos.
-- =====================================================================
create or replace function liberacao_criar(
  p_setor text,
  p_titulo text,
  p_setor_requisitante text,
  p_nome_arquivo text,
  p_url_arquivo text,
  p_itens jsonb default '[]'::jsonb
) returns liberacao
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_row liberacao;
begin
  if trim(coalesce(p_setor, '')) = '' then raise exception 'Informe o setor.'; end if;
  if trim(coalesce(p_titulo, '')) = '' then raise exception 'Informe o título do documento.'; end if;
  if trim(coalesce(p_setor_requisitante, '')) = '' then raise exception 'Selecione o setor requisitante.'; end if;

  v_id := 'LIB-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text;

  insert into liberacao (id, setor, titulo, setor_requisitante, nome_arquivo, url_arquivo, status, criado_em, itens)
  values (v_id, trim(p_setor), trim(p_titulo), trim(p_setor_requisitante), p_nome_arquivo, p_url_arquivo, 'Setor', now(), coalesce(p_itens, '[]'::jsonb))
  returning * into v_row;

  return v_row;
end;
$$;

-- =====================================================================
-- liberacao_avancar: mesma lógica de handleLiberacaoAvancar. Setor -> sem
-- senha; Encarregado -> senha do Encarregado; Imediato -> senha do
-- Imediato. NÃO dispara registro automático no Registro ao chegar em
-- "Liberados" — isso continua manual, via liberacao_registrar_retirada.
-- =====================================================================
create or replace function liberacao_avancar(p_id text, p_senha text, p_itens jsonb default null)
returns liberacao
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row liberacao;
  v_encarregado_senha constant text := 'encarregado321';
  v_imediato_senha constant text := 'imediato321';
begin
  select * into v_row from liberacao where id = p_id for update;
  if not found then raise exception 'Card não encontrado.'; end if;

  if v_row.status = 'Setor' then
    update liberacao set status = 'Encarregado', transmitido_em = now()
    where id = p_id returning * into v_row;
  elsif v_row.status = 'Encarregado' then
    if p_senha is distinct from v_encarregado_senha then
      raise exception 'Senha do Encarregado incorreta.';
    end if;
    update liberacao
      set status = 'Imediato',
          aprovado_encarregado_em = now(),
          itens = coalesce(p_itens, itens)
    where id = p_id returning * into v_row;
  elsif v_row.status = 'Imediato' then
    if p_senha is distinct from v_imediato_senha then
      raise exception 'Senha do Imediato incorreta.';
    end if;
    update liberacao set status = 'Liberados', aprovado_imediato_em = now()
    where id = p_id returning * into v_row;
  else
    raise exception 'Este documento já está liberado e não pode avançar mais.';
  end if;

  return v_row;
end;
$$;

-- =====================================================================
-- liberacao_recusar: mesma lógica de handleLiberacaoRecusar. Sem senha.
-- =====================================================================
create or replace function liberacao_recusar(p_id text)
returns liberacao
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row liberacao;
  v_novo_status text;
  v_etapa text;
begin
  select * into v_row from liberacao where id = p_id for update;
  if not found then raise exception 'Card não encontrado.'; end if;

  if v_row.status = 'Encarregado' then
    v_novo_status := 'Setor'; v_etapa := 'Encarregado';
  elsif v_row.status = 'Imediato' then
    v_novo_status := 'Encarregado'; v_etapa := 'Imediato';
  else
    raise exception 'Este documento não pode ser recusado nesta etapa.';
  end if;

  update liberacao
    set status = v_novo_status,
        ultima_acao = 'Recusado pelo ' || v_etapa || ' em ' || to_char(now(), 'DD/MM/YY HH24:MI')
  where id = p_id returning * into v_row;

  return v_row;
end;
$$;

-- =====================================================================
-- liberacao_excluir: mesma lógica de handleLiberacaoExcluir. Só apaga se
-- ainda estiver em "Setor". Devolve a url_arquivo pro app.js mandar
-- excluir o PDF no Drive via Apps Script (Postgres não fala com o Drive).
-- =====================================================================
create or replace function liberacao_excluir(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row liberacao;
begin
  select * into v_row from liberacao where id = p_id for update;
  if not found then raise exception 'Card não encontrado.'; end if;
  if v_row.status <> 'Setor' then
    raise exception 'Só é possível excluir documentos que ainda estão na coluna Setor.';
  end if;

  delete from liberacao where id = p_id;

  return jsonb_build_object('deleted', true, 'url_arquivo', v_row.url_arquivo);
end;
$$;

-- =====================================================================
-- liberacao_registrar_retirada: mesma lógica de
-- handleLiberacaoRegistrarRetirada + registrarRetiradaDaLiberacao_.
-- Exige a senha da Diretoria. Idempotente (registrado_no_estoque_em).
-- Chama retirar_material() por dentro — nunca duplica a lógica de
-- desconto de estoque.
--
-- Validação de pré-condição (senha errada, setor/categoria vazios, card
-- não encontrado, status errado, já registrado) continua lançando exceção
-- de verdade — nada foi escrito ainda nesses casos.
--
-- Já os casos onde ALGO já foi gravado mas ainda há um aviso (itens
-- inválidos, retirar_material falhou, produto não encontrado no Estoque)
-- NÃO lançam exceção — devolvem {"registrado": bool, "aviso": texto|null}.
-- Isso é diferente do Code.gs original (lá, cada gravação na planilha já
-- era imediata e separada da mensagem de aviso); aqui, a função inteira é
-- UMA transação — um RAISE no final desfaria também o que já foi gravado
-- antes dele. O app.js decide o que mostrar olhando o campo "aviso".
-- =====================================================================
create or replace function liberacao_registrar_retirada(
  p_id text,
  p_senha text,
  p_setor text,
  p_categoria text,
  p_tempo numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_diretoria_senha constant text := 'diretoria321';
  v_card liberacao;
  v_setor text := trim(coalesce(p_setor, ''));
  v_categoria text := trim(coalesce(p_categoria, ''));
  v_itens_validos jsonb;
  v_items jsonb;
  v_nao_encontrados text[];
  v_aviso text;
  v_data_lancamento date := current_date;
  v_mes smallint := extract(month from current_date)::smallint;
begin
  if p_senha is distinct from v_diretoria_senha then
    raise exception 'Senha da Diretoria incorreta.';
  end if;
  if v_setor = '' then raise exception 'Selecione o setor.'; end if;
  if v_categoria = '' then raise exception 'Selecione a categoria dos itens.'; end if;

  select * into v_card from liberacao where id = p_id for update;
  if not found then raise exception 'Card não encontrado.'; end if;
  if v_card.status <> 'Liberados' then
    raise exception 'Só é possível registrar a retirada de PIMs que já estão na coluna Liberados.';
  end if;
  if v_card.registrado_no_estoque_em is not null then
    raise exception 'Este PIM já teve a retirada registrada em %.', to_char(v_card.registrado_no_estoque_em, 'DD/MM/YY HH24:MI');
  end if;
  if v_card.itens is null or jsonb_array_length(v_card.itens) = 0 then
    raise exception 'Este PIM não tem itens (produto/quantidade) identificados para registrar.';
  end if;

  -- Só itens com produto/quantidade válidos (mesma regra do app original —
  -- nunca "sucesso silencioso" quando sobra zero item válido).
  select jsonb_agg(elem) into v_itens_validos
  from jsonb_array_elements(v_card.itens) elem
  where trim(elem->>'produto') <> '' and coalesce((elem->>'qtd')::numeric, 0) > 0;

  if v_itens_validos is null or jsonb_array_length(v_itens_validos) = 0 then
    -- IMPORTANTE: não dá RAISE EXCEPTION aqui. Uma função Postgres roda
    -- inteira numa única transação — se ela terminasse em exceção, o UPDATE
    -- do ultima_acao logo abaixo seria desfeito junto (diferente do Code.gs
    -- original, onde cada escrita na planilha já era commitada na hora,
    -- separada da mensagem de aviso mostrada depois). Por isso devolve o
    -- aviso dentro do retorno, e quem decide se isso é "erro" pro usuário é
    -- o app.js, olhando o campo "aviso".
    v_aviso := 'Os itens deste PIM não têm produto/quantidade válidos (nome vazio ou quantidade zero) — nada foi lançado no Registro. Reabra o card e confira a seção "Itens do Documento".';
    update liberacao set ultima_acao = v_aviso where id = p_id;
    return jsonb_build_object('registrado', false, 'aviso', v_aviso);
  end if;

  -- Monta os itens no formato esperado por retirar_material. Setor e
  -- categoria vêm sempre do override (nunca do card); a unidade é
  -- resolvida pela aba Estoque, quando o produto bate por nome exato.
  select jsonb_agg(
      jsonb_build_object(
        'produto', t.elem->>'produto',
        'qtd', (t.elem->>'qtd')::numeric,
        'un', coalesce(e.un, ''),
        'categoria', v_categoria,
        'data', to_char(v_data_lancamento, 'YYYY-MM-DD'),
        'pagoEm', to_char(v_data_lancamento, 'YYYY-MM-DD'),
        'setor', v_setor,
        'pedido', v_card.titulo,
        'mes', v_mes,
        'tempoRetiradaMinutos', case when t.ord = 1 and p_tempo is not null then p_tempo else null end
      )
      order by t.ord
    )
  into v_items
  from jsonb_array_elements(v_itens_validos) with ordinality as t(elem, ord)
  left join estoque e on lower(e.produto) = lower(trim(t.elem->>'produto'));

  -- Produtos do PIM sem nome correspondente exato na aba Estoque — ainda
  -- entram no Registro (pra não perder a quantidade), mas sem baixa de
  -- estoque. Fica um aviso registrado no card.
  select array_agg(trim(t.elem->>'produto'))
  into v_nao_encontrados
  from jsonb_array_elements(v_itens_validos) as t(elem)
  where not exists (
    select 1 from estoque e where lower(e.produto) = lower(trim(t.elem->>'produto'))
  );

  begin
    perform retirar_material(v_items);
  exception when others then
    -- retirar_material é "tudo ou nada" por si só (ver comentário na
    -- função) — se ela falhou, nada dela foi gravado, então aqui SIM nada
    -- foi perdido ao não dar raise. Só o aviso precisa sobreviver.
    v_aviso := 'Não foi possível lançar automaticamente no Registro: ' || sqlerrm;
    update liberacao set ultima_acao = v_aviso where id = p_id;
    return jsonb_build_object('registrado', false, 'aviso', v_aviso);
  end;

  update liberacao set registrado_no_estoque_em = now() where id = p_id;

  if v_nao_encontrados is not null and array_length(v_nao_encontrados, 1) > 0 then
    -- Mesmo motivo do comentário acima: a retirada JÁ foi gravada com
    -- sucesso (registrado_no_estoque_em acabou de ser setado) — não dá
    -- RAISE aqui, senão essa gravação toda seria desfeita por causa de um
    -- aviso que deveria só ser informativo.
    v_aviso := 'Retirada registrada no Registro, porém sem baixa de estoque para os itens não encontrados na aba Estoque: ' || array_to_string(v_nao_encontrados, ', ');
    update liberacao set ultima_acao = v_aviso where id = p_id;
    return jsonb_build_object('registrado', true, 'aviso', v_aviso);
  end if;

  return jsonb_build_object('registrado', true, 'aviso', null);
end;
$$;

-- =====================================================================
-- Permissões: as 4 tabelas só aceitam leitura via RLS (002_rls.sql); toda
-- escrita passa obrigatoriamente por uma destas 7 funções.
-- =====================================================================
grant execute on function retirar_material(jsonb) to anon, authenticated;
grant execute on function registrar_entrada(jsonb) to anon, authenticated;
grant execute on function liberacao_criar(text, text, text, text, text, jsonb) to anon, authenticated;
grant execute on function liberacao_avancar(text, text, jsonb) to anon, authenticated;
grant execute on function liberacao_recusar(text) to anon, authenticated;
grant execute on function liberacao_excluir(text) to anon, authenticated;
grant execute on function liberacao_registrar_retirada(text, text, text, text, numeric) to anon, authenticated;
