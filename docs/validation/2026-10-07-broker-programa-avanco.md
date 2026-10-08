# Programa Broker — avanço atualizado em 08/10/2026

O objetivo permanece o programa P0–P10 do plano mestre `docs/superpowers/plans/2026-10-05-broker-programa-integracao.md`. Esta atualização registra incrementos comprováveis; nenhum componente interno encerra uma fase que ainda depende de integração, carga ou homologação real.

## Linha de base e publicação

- Checkout e publicação: main; base deste incremento `0dd390c77f0b7d5c9dd9d1d823a366cbc6f30882`. Main remota conferida em 08/10 e ainda nessa revisão antes da nova publicação.
- D4 anterior: CI aprovado e imagens publicadas. Isso não comprova instalação de D4 no servidor.
- Última evidência de servidor fornecida pelo operador: readiness 200, runtime V2 habilitado, Evolution interno `evolution:8080`, baseline D2 `0046_central_transport` compatível. A instalação posterior continua sem evidência nova neste registro.
- A nova cadeia incluirá `0049_qr_outbound_observations`; imagens API/web precisam ter o mesmo SHA aprovado na main. Migração e instalação no Dokploy são executadas pelo operador, preservando as conexões existentes.

## Incrementos deste ciclo

| Frente | Implementação | Evidência e limite |
| --- | --- | --- |
| P3 espera | Prazo persistido e simulação com avanço virtual, eventos ordenados, IO sem rede e descarte de respostas antigas após mudança de input | 38 testes do Studio; 13 integrações de serialização/autoridade; suites focadas do motor/API. Não representa mensagem enviada pelo WhatsApp |
| P3 horário | Agenda semanal, fuso IANA e exceções por data; portas dentro/fora; formulário e motor canônico | 118 testes integrados de contrato, motor e editor. Relógio injetado e horário de verão examinados |
| P3 importação | Remover referência de credencial de HTTP/SQL/IA na nova importação e solicitar seleção local | 39 testes focados; grafo e replay histórico preservados. Jade/n8n continuam sujeitos a relatório parcial |
| P4 saída observada | Persistência de eventos fromMe, correlação somente por ID do provedor, espelhamento identificado e recuperação explícita | 36 integrações QR, 38 UI e 25 HTTP focais aprovados; revisão independente PASS. UNKNOWN não equivale a enviado; observação incerta não prova atendente nem permite reenvio cego |
| P8 C0a | Calculadora de planejamento e diagnóstico local sanitizado de schema/readiness/flag | 37 testes da calculadora e 33 do diagnóstico. Nenhuma medição do host ou prova de capacidade física |
| P8 C1a/C1a2 | Configuração explícita de pools por processo e componente, com encaminhamento no Compose do Dokploy | 69 testes de runtime e 42 de pools/Compose focados; defaults e timeouts de statements preservados. Soma por réplicas precisa caber no orçamento real do banco |
| P8 C4 parcial | 500 tenants, 5.000 canais QR e 5.000 Meta sintéticos, quotas e grants coerentes, consulta e atualização sob RLS real | 3 testes PostgreSQL aprovados. Nenhum socket WhatsApp, sessão Evolution, carga sustentada ou throughput foi criado/medido |
| P10a preparação | Registro offline H01–H24, metadados de release e referências opacas de evidências | 36 testes com fixtures sintéticas. Sempre informa que homologação e verificação independente não estão aprovadas; não executa testes no servidor |

Revisão independente encontrou e exigiu correções de respostas antigas de simulação, evento de socket do diagnóstico, recuperação de tentativa sem eco e ordem de locks dos workers. Mensagens externas observadas foram separadas da quota de novos envios: o fato pode ser recebido durante suspensão, sem liberar novos envios de operador ou automação. O fence de exclusão também precisa cobrir o ledger antes da classificação canônica. Verificação completa e revisão final são requisitos da publicação; resultados focados não os substituem.

## Gates locais atuais

- `npm test -- --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000`: 289 arquivos e 2.111 testes aprovados em 08/10, na árvore final deste incremento. O orçamento maior pertence somente à execução local; os limites do CI foram preservados. Uma tentativa anterior com quatro workers excedeu o limite de 30 segundos do artefato PDF; a repetição completa com dois workers terminou sem falhas, sem mudar esse limite.
- `security:release`: 251 rotas, zero achados; relatório atual em 08/10, 09:35 BRT. A primeira falha sanitizada do scanner não se reproduziu, sem mudança do scanner ou redução de cobertura.
- Contratos públicos, notices de sete pacotes, PDF histórico (19 páginas) e gate da auditoria aprovados. O artefato de auditoria histórica foi preservado.
- `test:integration -- --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000`: 94 arquivos e 716 testes PostgreSQL/Redis aprovados, sem omissões, em 08/10. Focais posteriores à unidade global cobrem o motivo adicional de reconciliação no contrato/UI/HTTP.
- Build, tipos e OpenAPI final aprovados; bundle com 11 arquivos e zero achados. Entry points compilados: dois arquivos e dois testes aprovados com banco descartável migrado em 08/10. Revisão P4 final PASS. O CI e a publicação seguem seus gates próprios. A recusa de exclusão com mensagem SENDING/UNKNOWN é testada e conservada; cenário de fence restaurada não é apresentado como interleaving permitido pelo serviço vigente.
- `npm audit --audit-level=high`: zero vulnerabilidades. O gate original do submódulo permanece obrigatório; a lentidão do helper Git local está sendo diagnosticada, sem alterar a referência upstream nem o timeout do gate.
- Fonte JRC de referência buscada por leitura: `80f7305ad0eac310d661071856f67a7e048881de`, da branch `codex/global-quick-actions-20260930`; a imagem efetiva do host ainda não foi comparada.

Próximos incrementos por frente: [roteiro P3–P10 de 08/10](../superpowers/plans/2026-10-08-broker-proximos-incrementos-p3-p10.md). Procedimento de instalação/teste do candidato: [primeiro corte P3/P4](2026-10-08-broker-primeiro-corte-p3-p4-instalacao.md).

## Fases ainda abertas

| Fase | Trabalho necessário para concluir |
| --- | --- |
| P0 | Inventário efetivo dos dois hosts, migrações, flags, backup com Redis e restauração da janela consistente |
| P1/P2 | Regressão real da pausa/transferência/retomada nos perfis finalizados; D1–D4 publicados não encerram homologação D5 |
| P3 | Ações de atendimento, mídia, caminhos de captura/timeout, HTTP/IA delimitados e dependências de subflow conforme catálogo aprovado |
| P4 | Finalizar reconciliação operacional, homologar mensagens do aparelho e ecos no servidor, incluindo reinício/falha |
| P5 | Grupos por conexão, participação, isolamento, política de entrada/saída, limite e jornada opt-in |
| P6 | Comprovar capacidade elegível de voz e áudio bidirecional com provedor/central; sinal de chamada ou botão não fecha voz |
| P7 | Fechar lacunas concretas de administração, relatórios e matriz de permissão/caixa, sem reconstruir módulos existentes |
| P8 | Telemetria/carga, mídia privada S3, backup Redis/objetos, múltiplos motores QR, reconexão e teste de capacidade observado |
| P9 | Módulos Flow/QR delegados, catálogo/contrato comum e escopo persistido por caixa; conferir fonte e imagem do host JRC antes de editá-lo |
| P10 | Instalação e jornada completa no Welton, JRC tenant A/B e Chatwoot externo; registrar versão/correlação/resultado real e piloto |

As fixtures JRC A/B e Chatwoot externo foram adiadas pelo usuário para a homologação final. Ativos Meta/voz e acesso ao servidor externo não foram fornecidos. Não há conversão silenciosa entre QR/Meta/central/standalone para contornar um pré-requisito ausente.

## Procedimento de aceite

Cada incremento segue: RED funcional → implementação → testes apropriados e suites obrigatórias → revisão → commit/main → CI do mesmo SHA → imagens API/web → guia Dokploy → migração/readiness/workers → jornada real. A matriz H01–H24 permanece a referência de aceite final; resultado pendente, simulado ou não executado não conta como aprovado em produção.
