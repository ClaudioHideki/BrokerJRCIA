# Fase 10 — hardening, recuperação e release

> **Programa:** `docs/superpowers/plans/2026-09-22-jrc-platform-v2-program.md`
>
> **Base:** commit de encerramento da Fase 9 `e040fc0`

## Objetivo

Fechar os critérios locais de produção do JRC Platform V2: restore drill mensurável, carga e justiça por organização, cadeia de entrega imutável, imagens com SBOM/provenance/assinatura, promoção por digest e runbook Dokploy verificável. Publicação e implantação permanecem ações separadas e dependem de aprovação final.

## Task 1 — matriz consolidada dos marcos 2 a 6

1. Mapear cada requisito de segurança, canais, automação, atendimento e UX para código e teste existente.
2. Criar um gate automatizado que falhe se os controles estruturais obrigatórios desaparecerem.
3. Registrar lacunas que dependem de homologação externa sem confundi-las com implementação local.

## Task 2 — restore drill reproduzível

1. Criar composição isolada com PostgreSQL, Evolution e volumes sintéticos.
2. Gerar backup cifrado, verificar manifesto, restaurar em banco novo e medir RPO/RTO do exercício.
3. Validar schema, RLS, duas organizações, roles sem `BYPASSRLS` e arquivo de sessão sintético.
4. Produzir evidência sanitizada e runbook de recuperação.

## Task 3 — carga, fairness e suspensão

1. Testar carga concorrente com pelo menos duas organizações e uma organização ruidosa.
2. Comprovar orçamento por rodada, timeout, retomada, suspensão e preservação de pendências.
3. Registrar limites do teste local e comandos para repetir em homologação.

## Task 4 — supply chain e imagens imutáveis

1. Fixar imagens de CI e Actions críticas por digest/SHA.
2. Construir API e web uma vez, publicar somente quando `publish=true` e referenciar por digest.
3. Gerar SBOM e provenance; assinar os digests publicados com identidade OIDC.
4. Reter relatório sanitizado de digests e artefatos.

## Task 5 — promoção e rollback Dokploy

1. Validar Compose e ambiente sem imprimir segredos.
2. Exigir imagens por digest, migration job único, readiness e limites de recursos.
3. Documentar promoção homologação -> produção da mesma imagem e rollback somente da aplicação.
4. Corrigir documentação conflitante com autenticação forte e fronteiras administrativas.

## Task 6 — gate final

Executar Node 24.19.0, instalação fechada, typecheck, build, unitários, integração, E2E, contratos, auditoria, restore drill, carga, build/smoke Docker, manifesto e diff limpo. Gerar `docs/implementation/jrc-platform-v2/phase-10-report.md` com evidência local e homologações externas pendentes.

## Critério de conclusão

A Fase 10 termina quando todos os controles locais forem automatizados e verdes. Meta, Baileys, Chatwoot, GHCR e Dokploy reais serão marcados como homologação externa pendente enquanto não houver credenciais/infraestrutura fornecidas; isso não autoriza publicação ou deploy.
