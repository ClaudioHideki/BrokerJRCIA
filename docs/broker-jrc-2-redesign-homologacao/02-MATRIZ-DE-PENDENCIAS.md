# Matriz de pendências — Broker 2

Base d1b66a,30/10/2026. Estado integral por item, sem confundir existência do código com aceite operacional. Responsável é uma função proposta, não pessoa já designada.

| ID | Estado / prioridade | Evidência e ação delimitada | Responsável | Aceite observável |
|---|---|---|---|---|
| H01 | PARCIAL/P1 | Saúde status consulta qualquer FAILED/UNKNOWN histórico; delimitar falha ativa com política explícita sem apagar UNKNOWN | Backend JRC | Falha histórica superada não mascara sucesso; UNKNOWN não resolvido permanece sinalizado; mapping atual e callback válido |
| G01 | PARCIAL/P1 | Catálogo vencido/zero selecionados produzem GROUP_CENTRAL_SCOPE_CHANGED; separar pré-condição de falha de transporte | Backend+UX JRC | Grupo não selecionado não gera envio nem avalanche de erro; motivo/ação claros; escopo nunca ampliado automaticamente |
| I01 | PARCIAL/P1 |119 falhas por política de atendimento na fotografia | Integração JRC | Ler política remota sanitizada; reproduzir e corrigir apenas a condição real em lab |
| I02 | NÃO VERIFICADO/P1 |396 FAILED/4 UNKNOWN/1382 PENDING históricos em integration_jobs | Operação JRC | Diagnóstico por código/idade/canal; UNKNOWN reconciliado por ID estável sem novo envio; destino desativado não cresce indefinidamente |
| B02 | PENDENTE/P1 | Origem Evolution sem captura atômica/outbox comprovada | Engine JRC | Crash antes/depois HTTP/ACK e restart da imagem exata sem perda ou efeito duplicado |
| B03 | PARCIAL/P1 | Recibo já existe; KEEP; prova física ausente | Backend+storage JRC | Cópia privada hash/tamanho; ACK perdido idempotente; restore de DB+objetos; zero DELETE na origem |
| B05 | PARCIAL/P1 | Logger JRC sanitizado; stdout Evolution fora da garantia | Segurança JRC | Canários sintéticos ausentes em stdout/coletor/backup; correlação técnica preservada |
| B07 | PARCIAL/P2 | Watermark webhook não ordena fatos posteriores ao polling | Backend JRC | Interleavings PG, mudança de binding, empates e relógio não regridem estado |
| B12 | PARCIAL/P2 | Replay explícito FAILED parceiro e ledger já implementados | Backend JRC | Concorrência/expiry/revogação/ACK perdido e receptor deduplicado; nunca envio WhatsApp novo |
| B13 | PARCIAL/Gate | Planner/pools existem; orçamento consolidado real ausente | Infra JRC | Pools+réplicas+engine+rollout+reserva cabem em PG e cumprem SLO medido |
| B14 | NÃO VERIFICADO/Gate | Processamento sequencial até20 por tenant, timeout10s | Backend+performance | Tenant lento não causa starvation; p95/p99 e espera máxima por tenant aprovados |
| R01 | PENDENTE/P1 | Backups Dokploy vazios; externo não verificado | Infra JRC | Backup cifrado externo, RPO/RTO definidos e restore integral medido em destino vazio |
| R02 | PENDENTE/P1 | Comparador de journal74/77 retorna DIVERGED | Infra+backend | Matriz de compatibilidade por digest; rollback/forward recovery documentados sem editar journal |
| D01 | PARCIAL/P1 | Canonical difere de guias/perfis públicos | API JRC | Rotas, scopes, exemplos e limites correspondem ao HEAD; negativos verificados |
| S01 | PENDENTE/P1 | Simulador SQLite funciona; PG/S3/Broker real não integrado | QA JRC | Worker real+receptor persistente+download autenticado; falhas e restart com reconciliação |
| O01 | PARCIAL/P1 | HTTP200 não cobre trabalhadores silenciosos | Operação JRC | Alarmes por heartbeat, oldest pending, UNKNOWN, backlog, pools, storage e catálogo |
| C400 | PENDENTE/Gate | Plano50/100/200/400 sem execução | Performance JRC | Três repetições por estágio, zero perda/duplicidade/escape de tenant e SLO |
| C900 | NÃO VERIFICADO/Gate | Preparação apenas | Arquitetura JRC | Dimensionamento recalculado após400; execução futura autorizada e rastreada |
| X01 | DEPENDENTE EXCLUSIVAMENTE DO CCLX | Versão/fork/jobs/PubSub/configuração real | CCLX | Manifesto real e homologação no ambiente disponibilizado |
| X02 | DEPENDENTE EXCLUSIVAMENTE DO CCLX | Retenção/backup/restore da cópia sob operação do cliente | CCLX | Evidência física de recuperação e política assinada; contrato/conector seguem compartilhados |

## Ordem prática

1. Corrigir e testar H01 em escopo pequeno; mapear diagnóstico de grupos G01 sem automatizar ação produtiva.
2. Disponibilizar laboratório descartável seguro para testes PG/Redis/S3; executar I01/B07/B12/S01.
3. Fechar origem durável, logs e recuperação antes de declaração de operação resiliente.
4. Executar capacidade progressiva, sem converter defaults de recursos em GO400.
5. Homologar X01/X02 com cliente; pendências internas continuam responsabilidade JRC.

A matriz anterior em `evidencias/baseline-20261030/matriz-pendencias.csv` permanece evidência histórica. Esta versão acrescenta o recorte H01 e critérios de saída; não declara incidentes resolvidos.
