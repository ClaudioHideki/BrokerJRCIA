# Preparação da homologação final do Broker

Em 06/10/2026 o usuário decidiu configurar os tenants e a instalação externa ao final do desenvolvimento. Isso não bloqueia implementação nem testes locais; os cenários externos permanecem NOT_RUN até existir evidência real.

Referências: [programa](../superpowers/plans/2026-10-05-broker-programa-integracao.md), [arquitetura](../superpowers/specs/2026-10-05-broker-independente-centrais-design.md) e [matriz H01–H24](2026-10-05-broker-programa-baseline.md).

## Ambientes a preparar

| Perfil | Preparação no momento da homologação | Identidade a registrar |
| --- | --- | --- |
| S0 | Empresa de teste no Broker, número exclusivo, nenhuma central configurada | Organização, canal, instância e transporte Broker |
| J1 | Tenant A do JRC Conversas, caixa exclusiva, administradores e agentes de teste | URL, Account ID, Inbox ID, organização/canal correspondentes no Broker |
| J2 | Tenant B independente, outros usuários e credenciais | Mesmos campos de J1, com vínculos separados |
| E1 | Instalação externa de Chatwoot administrada para teste, token configurado diretamente no Broker | Host normalizado, versão, Account ID, Inbox ID e vínculo aprovado |
| C1 | Caixa com transporte próprio da central e execução única no Broker | Provedor, webhook, grants e executor anterior desativado no cutover |

A caixa do Welton permanece autorizada para testes controlados, conforme informado pelo usuário. Seu vínculo existente não substitui J2 nem E1. Não tratar IDs de conta/caixa iguais em hosts diferentes como a mesma identidade.

## Ordem de execução

1. Publicar o candidato revisado na main e confirmar CI, imagens, digests, assinatura e versão de schema esperada.
2. No Dokploy operado pelo usuário, conferir imagens efetivas dos containers, journal de migrações, flags e backups de PostgreSQL, Redis e estado do provedor. Registrar restore testado antes do upgrade.
3. Criar os perfis acima e configurar credenciais diretamente nos sistemas. Conferir destino, conta, caixa, agentes, times e etiquetas com os catálogos reais. Não enviar tokens na conversa nem substituir webhooks sem o cutover previsto.
4. Executar a jornada pequena em cada perfil: mensagem externa → menu → captura → transferência para fila/time/agente → resposta humana → retomada explícita. Registrar entrega observada, versão e correlação; enfileiramento não comprova entrega.
5. Executar H01–H24, incluindo revogação, queda de serviço, duplicatas, isolamento e recuperação. Grupos e chamadas exigem teste no provedor e no adaptador compatível; texto ou QR conectado não comprova voz.
6. Depois da integração das interfaces Flow/QR na central, repetir a jornada pela interface que o cliente utilizará. Essa repetição é parte da aceitação final.

## Resultado e evidência

Para cada combinação cenário/perfil, registrar PASS, FAIL, BLOCKED ou NOT_RUN, data, commit, digests, journal, configuração não secreta, esperado e observado. NOT_APPLICABLE exige uma capacidade explicitamente fora do perfil; não pode encerrar uma funcionalidade solicitada ainda sem prova.

Testes automatizados locais e CI aprovados são evidências de código. A imagem publicada é evidência de artefato. Deploy saudável é evidência de disponibilidade. A integração somente é aceita após a jornada real e o isolamento entre os perfis acima. Evidências com conversas, números ou credenciais ficam fora do Git em armazenamento restrito; versionar somente o resumo sanitizado.
