# Fase 10 — hardening e release

Data da validação: 22/09/2026

## Resultado local

A Fase 10 fecha os controles locais de recuperação, supply chain e promoção do JRC Platform V2. A publicação no GHCR e a implantação no Dokploy continuam separadas e não foram executadas.

## Matriz consolidada dos marcos 2 a 6

| Marco | Implementação e evidência |
| --- | --- |
| Segurança e multitenancy | Papéis globais separados, TOTP disponível e padrão no Dokploy, RLS forçada, roles `NOBYPASSRLS`, API keys por tenant, suporte motivado/auditado, suspensão e limites validados em PostgreSQL |
| Canais | Fachada canônica para Meta e QR, Embedded Signup, webhooks, mídia, templates, QR/pairing temporário, identidade de sessão e reconciliação; homologação real permanece externa |
| Automation Studio | Definição JRC versionada, publicação imutável, bindings, execução durável, waits, outbox, cofre, importadores Typebot/n8n e migração legada concluída |
| Atendimento e operação | Conversas, mensagens, mídia, handoff, JRC Conversas/Chatwoot, health center, filas, auditoria, limites e relatórios operacionais |
| UX | Portal tenant e administração JRC separados, navegação canônica de canais, console legada preservada, responsividade, teclado e E2E desktop/mobile |

## Restore drill

`npm run test:restore-drill` usa PostgreSQL 16.4 fixado por digest e uma composição Docker isolada. O exercício cria duas organizações sintéticas, política RLS forçada, papel runtime sem `BYPASSRLS`, banco Evolution e arquivo de sessão; gera backup AES-256-GCM, verifica manifesto/checksums, restaura os bancos e confirma os dados e o arquivo.

Execução local aprovada:

- backup cifrado: 3.513 ms;
- restauração e validação: 5.825 ms;
- RPO sintético: 0 s;
- duas organizações e uma sessão restauradas;
- recursos Docker temporários removidos no `finally`.

Os números são do conjunto sintético local e não constituem RTO/RPO contratual. O mesmo comando deve ser repetido em homologação com volume equivalente ao de produção.

## Carga, suspensão e justiça

Os workers descobrem organizações em páginas limitadas, aplicam shard determinístico e processam uma rodada limitada por organização. PostgreSQL usa `statement_timeout`; adapters externos possuem timeouts próprios. Os testes focais aprovados cobrem configuração de shards, organização ruidosa sem alteração de autoridade tenant, cota concorrente, suspensão após claim, preservação de pendências e suporte auditado: 7 testes unitários e 14 testes de integração em PostgreSQL real.

## Supply chain

- Actions críticas estão fixadas por SHA de 40 caracteres.
- PostgreSQL e Redis usados em CI/release estão fixados por digest.
- O workflow manual mantém `publish=false` como padrão.
- API e web geram SBOM e provenance BuildKit.
- Quando `publish=true`, os digests são assinados por Cosign com identidade GitHub OIDC.
- A evidência sanitizada registra revisão e digests, sem tokens.
- Dokploy exige imagens da aplicação por digest e usa autenticação administrativa `password_totp` por padrão.

## Gates executados

- typecheck e build de produção: aprovados;
- unitários/contratos HTTP: 183 arquivos e 1.203 testes aprovados;
- integração PostgreSQL/Redis: 41 arquivos e 253 testes aprovados;
- E2E Chromium: 27 jornadas aprovadas e 5 variações mobile intencionalmente ignoradas;
- restore drill Docker: aprovado;
- gate de hardening do release: 4/4;
- YAML dos workflows e Compose: válido;
- Compose Dokploy interpolado com valores sintéticos: válido;
- release security scan: 170 rotas, zero achados;
- audit gate: nenhum achado CRITICAL/HIGH aberto;
- suspensão/limites/plataforma em PostgreSQL: 14/14;
- fairness/configuração/admin: 7/7;
- backup criptográfico: 1/1.
- imagem final construída com Node.js 24.19.0 fixado, migrations/readiness aprovadas e runtime `uid 1000`;
- digest local final: `sha256:52840e598927251b0476d8e2724bfa1aed449e7bb7bceb58ddbebc32bf677644`.

## Homologações externas pendentes

Dependem de contas, ativos ou infraestrutura que não estão disponíveis localmente: Meta Embedded Signup e envio/recebimento real; pareamento Baileys em aparelho autorizado; JRC Conversas/Chatwoot público; conectores de IA; carga com volume de produção; publicação GHCR; verificação pública da assinatura; promoção e rollback no Dokploy. Essas pendências não foram simuladas como sucesso.

Nenhuma imagem foi publicada, nenhum segredo real foi usado e nenhum deploy ou migration de produção foi executado.
