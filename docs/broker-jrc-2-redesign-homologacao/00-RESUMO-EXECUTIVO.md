# Broker JRC 2.0 — primeira execução, 30/10/2026

**Parecer: parcialmente pronto; homologação integral JRC ainda não concluída.** Esta entrega consolida a investigação técnica e de produto e implementa o primeiro piloto. Não equivale ao término do programa Broker 2.0.

## Base e limites

- Base de código: `d1b66a56fe6d4f9202969784301abdf61490db45`.
- Branch de trabalho: `codex/broker-jrc-2-redesign-homologacao-20261030`.
- Main conferida por fetch: `be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`.
- Produção: fotografia reconciliada em 30/10, 12:06–12:15 UTC, detalhada em 01/04. Não houve novo deploy ou alteração de produção neste incremento.
- Não foram criadas migrations, endpoints ou permissões. Nenhum envio, replay, limpeza de fila ou carga real foi executado.

## Estado comprovado e problemas prioritários

A Fase 2 publicada possui API e web versionadas, journal com 77 migrations e testes históricos de CI. Isso não resolve a homologação dos fluxos completos. Na fotografia reconciliada havia 396 jobs FAILED, quatro UNKNOWN e 1.382 PENDING nas integrações. Essas contagens são datadas, não telemetria em tempo real.

1. FAILED histórico participa do cálculo de saúde como se fosse falha ativa. A interface também misturava configuração, conexão e entrega.
2. Catálogo de grupos vencido/seleção vazia e políticas de atendimento impedem entregas. Não podem ser corrigidos ampliando escopo automaticamente.
3. Continuidade durável na origem Evolution (B02), custódia física/restore de mídias (B03) e recuperação continuam bloqueadores internos.
4. B05/B07/B12/B13 têm implementação parcial; B14 precisa prova de justiça entre tenants. Não há GO400 ou comprovação de 900 sessões.
5. O Docker local inicialmente negou acesso no sandbox. A verificação elevada respondeu versão 29.5.2; isso remove o impedimento de acesso, mas ainda é necessário preparar laboratório descartável PG/Redis/MinIO e ensaiar falhas de processo. Dados produtivos não foram usados como fixtures.

## Produto e experiência

Foram pesquisadas 18 referências oficiais, com 36 linhas de comparação e limites de evidência explícitos no documento 05. A pesquisa é documental; não afirmamos ter testado os painéis dos concorrentes.

Problemas atuais: excessos de termos técnicos, diagnóstico sem causa/ação, informações históricas sem período, telas longas e estados de carregamento/erro incompletos. A proposta organiza o produto em visão geral, conexões, conversas, automações, integrações, API/webhooks, monitoramento e configurações; administração global permanece separada do contexto da empresa. A arquitetura completa está em 07 e as jornadas em 09.

Direção visual: identidade JRC existente, tokens centralizados, superfícies claras/escuras, alertas com texto além de cor, detalhes técnicos progressivos e ações contextualizadas. Não copiar código ou marca de concorrentes e não trocar a stack.

## Piloto implementado

Página `/operations/health`, consumindo apenas `GET /v1/operations/health` existente:

- Infraestrutura/processos, canais/integrações e filas/registros acumulados separados.
- UNKNOWN explicado sem assumir falta de envio nem oferecer replay indiscriminado.
- Falha de atualização mantém o último retrato com aviso explícito de desatualização.
- Uma consulta por vez, prazo de 20 segundos, cancelamento e descarte de respostas obsoletas.
- Validação da resposta sem quebrar a página; clock skew preservado como diagnóstico.
- Tema local claro/escuro e layout responsivo, sem dependências adicionais.
- Fixture de demonstração exclusivamente em desenvolvimento, identificada como simulada.

Testes e capturas estão em `evidencias/`; resultados consolidados em `evidencias/RESULTADOS.md`. O piloto melhora a leitura dos fatos; não modifica o cálculo SQL da saúde nem resolve as falhas de transporte.

## Ordem de implementação seguinte

1. H01/G01: política verificável de falha ativa/histórica e admissão de grupos; testes PG de concorrência e mudança de vínculo.
2. B02/B03 e recuperação: origem durável, recibo/cópia privada, retomada, restore e rollback.
3. B05/B07/B12/B13/B14: logs, ordenação, replay seguro, orçamento de pools e justiça entre tenants.
4. Completar diagnóstico de entregas, conexões, sessões, engines, incidentes e portal de desenvolvedores conforme matriz 11.
5. Simulador com PostgreSQL/S3 e worker real; benchmark progressivo 50/100/200/400, depois preparar 900 com dados medidos.

As dependências exclusivamente externas estão em 18. Nenhum bloqueador interno é transferido ao CCLX. A publicação permanece uma etapa separada após revisão e homologação.
