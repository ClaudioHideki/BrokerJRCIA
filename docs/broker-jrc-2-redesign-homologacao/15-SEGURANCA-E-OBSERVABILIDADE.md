# Segurança e observabilidade — controles e aceites

Base d1b66a,30/10/2026. Existência estática e testes isolados não constituem pentest ou atestado do runtime inteiro.

## Controles existentes

RLS e transações por organização; papéis app/auth/migrator distintos; scopes de API; revalidação antes de efeitos; HMAC de eventos; proteção SSRF; idempotência/leases; ledger de replay; FKs compostas e recibos imutáveis; logs JRC sanitizados; controle de identidade por fingerprint e callback por revisão.

media:archive deve ser selecionado explicitamente; chaves antigas não ganham scope. Replay parceiro não é uma permissão de envio WhatsApp. UNKNOWN exige reconciliação. APIs e operador devem preservar essas diferenças.

## Matriz de segurança funcional

| Risco | Teste/controle | Aceite |
|---|---|---|
| Tenant no body/ID de outro tenant | API+RLS+storage adversarial | Nenhuma leitura/efeito cruzado |
| Autoridade expira durante I/O | Revogar grant/endpoint/credential entre claim e send/retorno | Negação ou descarte protegido; sem vazamento |
| SSRF e redirect | Loopback/IP/userinfo/query/redirect e destino não autorizado | Bloqueio; laboratório injeta transporte sem relaxar produção |
| Replay/mensagem duplicada | ACK perdido, duas requests UUID iguais, stale lease | Uma intenção e um efeito; ledger rastreável |
| Mídia indevida | Hash/tamanho/ref incorretos, leitura sem auth | Negação; bytes parciais não READY |
| Log sensível | Canário sintético nos caminhos de erro/body/envelope | Ausente em stdout/coletor; IDs técnicos suficientes |
| Restauração sem chave | Restore com chave ausente/errada e rotação | Falha segura; recuperação correta provada com chave autorizada |

Fonte Evolution pode logar envelope bruto sob WEBHOOKS/LOG. Logger JRC não controla stdout de outro container. LOG_LEVEL não explícito na fotografia não prova conteúdo vazado; atestar binário/config efetiva com canários e coletor.

## Saúde por camada

- Disponibilidade: processo e dependências, readiness e schema.
- Integração: configuração/vínculo/identidade/callback por revisão.
- Transporte: conexão observada e evidência inbound/outbound recente.
- Execução: filas, oldest pending, heartbeat útil, leases, erros e UNKNOWN.
- Dados: objetos privados, hashes, backup/restore e retenção.
- Capacidade: latência por tenant, saturação e justiça entre organizações.

READY de configuração e200 público não devem ser exibidos como entrega confirmada. No serviço de saúde atual, qualquer falha histórica torna failure=true; piloto deve distinguir incidente vigente e histórico, preservando UNKNOWN.

## Telemetria proposta

Métricas sem payload, telefone, token, URL secreta ou QR: contagens por estado/código/etapa; oldest pending; eventos aceitos versus efeitos confirmados; latência de commit/claim/send/ACK; tentativas e leases; versão de catálogo; heartbeat de worker; pools/locks/IO/CPU/memória; bytes e erros de storage; idade do backup e resultado do restore.

Tenant/channel podem constar em logs restritos de correlação; limitar cardinalidade e acesso em métricas. IDs devem permitir seguir intenção sem expor conteúdo. Definir retention, acesso e destino dos logs, inclusive Evolution.

## Alarmes com ação

UNKNOWN novo→preservar intenção e pesquisar resultado remoto; backlog crescente/idade→identificar destino/lease/pré-condição; worker sem progresso→verificar heartbeat/dependência; catálogo vencido→revalidar escopo sem autoampliar; armazenamento/backup vencido→restabelecer proteção; saturação→interromper admissão de laboratório ou acionar plano operacional aprovado.

Aceite: injetar cada falha em lab e registrar alerta, responsável/runbook, tempo de detecção e recuperação. Ausência de alerta durante um teste normal não prova observabilidade.
