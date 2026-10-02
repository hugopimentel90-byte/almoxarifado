# Relatório de inconsistências — migração Supabase (Fase 1)

Gerado automaticamente a partir dos 4 CSVs originais. Nada foi corrigido — isso aqui é só a lista do que achei estranho, pra você decidir depois.

## estoque (2 itens)

- "REPARO VALVULA": saldo resultante 96642 destoa muito da faixa usual da categoria — conferir se é erro de digitação.
- Nome de produto parece um Date.toString() do JavaScript, não um nome de produto: "Sun Feb 01 2026 00:00:00 GMT-0400 (Amazon Standard Time)" (categoria Industrial, qtd 6).

## registro (2 itens)

- EXCLUÍDA do CSV (não pôde ser importada): "Cola plástica 90g" em 02/06/26 (Prefeitura, Pedido 2) — QTD veio como "Tempo de Retirada" em vez de um número. Me diga a quantidade real dessa retirada pra eu inserir manualmente depois.
- 588 de 1568 linhas têm o campo "Pedido" preenchido com um número grande (tipo timestamp, ex.: "1471194000" (PAPEL A4 BRANCO 210X297 RESMA DE 500, 27/07/26, Conforto); "1471194000" (ALCOOL ETILICO 70% 1L, 27/07/26, Conforto); "1471194000" (PANO LIMPEZA, 27/07/26, Conforto); "1471194000" (Vassoura piaçava, 27/07/26, Conforto); "1471194000" (SACO PLASTICO 40LT, 27/07/26, Conforto)) em vez de um rótulo como "Pedido 42" — isso começa por volta de 27/07/26 e vai até 01/10/26. Pode ser só um jeito diferente de preencher o campo, mas fica sinalizado pra você confirmar.

## liberacao (12 itens)

- LIB-1789501771965 (1490304000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789565699036 (1492109000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789566320215 (1492052000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789566640560 (1492153000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789670647686 (1493043000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789673320693 (1493003000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789674197418 (1493060000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789674898368 (1493081000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789674989106 (1493084000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789675448096 (1493085000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789676744994 (1493088000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).
- LIB-1789676828463 (149309000): itens contêm o prefixo "NÃO DEVE SER" colado no nome do produto (bug da extração do PDF já corrigido nesta sessão para PIMs novos).

