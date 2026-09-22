# 13 — Automation Studio alvo

## Experiência do editor

- Cabeçalho: nome, canal/destino, status, versão e ações testar/publicar.
- Esquerda: catálogo pesquisável por categoria.
- Centro: canvas com minimapa, zoom, encaixe e validações locais.
- Direita: propriedades tipadas do nó selecionado.
- Rodapé: erros, simulação, execuções e logs sanitizados.

## Catálogo mínimo

| Categoria | Nós |
|---|---|
| Entrada | início, mensagem recebida, webhook, cron, manual, evento Chatwoot, subflow |
| Conteúdo | texto, mídia, template Meta, botões, lista |
| Coleta | entrada, escolha, contato, localização, timeout |
| Lógica | condição, switch, variável, delay, subfluxo |
| Atendimento | handoff, atribuir agente/equipe, etiqueta, status |
| Dados | transformar/merge/loop, JSON e SQL PostgreSQL/MySQL read-only por padrão |
| Integração | HTTP/REST seguro, webhook, Chatwoot, Typebot/n8n autorizado |
| Código e IA | JavaScript isolado; gerar, classificar, extrair, resumir e agent com tools autorizadas |
| Controle | fim, falha, pausa, retomada |

## Semântica

- Grafos precisam ter início único, arestas válidas e caminhos termináveis.
- Publicar gera versão imutável; rascunho posterior não afeta a versão ativa.
- Menus e listas possuem fallback, limite de tentativas e timeout.
- Delay agenda continuação persistente, sem manter processo aberto.
- Handoff suspende automação até evento explícito de retomada.
- Subfluxos fixam versão e rejeitam recursão cíclica.
- Nós de integração declaram credencial por referência, timeout, repetição e política de dados.

## Importação

Importadores n8n e Typebot produzem relatório antes de salvar. Nós sem equivalente não são silenciosamente ignorados. O JSON original pode ser guardado como anexo de migração, mas nunca é executado pelo runtime principal.

## Observabilidade

Cada execução exibe linha do tempo, nó, duração, entrada/saída redigida, tentativa, correlação e motivo de falha. Reprocessamento parte de um checkpoint permitido e cria nova tentativa auditada.
