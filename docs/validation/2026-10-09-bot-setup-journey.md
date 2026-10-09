# Configuração guiada do bot por caixa

Incremento de usabilidade do programa aprovado. Não encerra a homologação das integrações nem os módulos delegados na central.

## Comportamento

A página da caixa apresenta a sequência Conectar WhatsApp → Publicar fluxo → Vincular bot à caixa → Testar atendimento e indica o próximo passo conforme a conexão, a versão publicada e o vínculo atual. Os links de criação, edição e publicação conservam o contexto da caixa e oferecem o retorno para vincular e testar.

Carregamento, falha de consulta e ausência de versões publicadas têm orientações próprias. Uma consulta de vínculo que falha identifica o estado preservado como anterior e impede alterações até nova leitura confirmada. A recuperação usa as revisões atuais do servidor.

A retomada explica continuar a espera, voltar ao menu e começar uma nova sessão. Publicar ou vincular um fluxo não retoma automaticamente uma conversa em atendimento humano. A confirmação continua explícita e a retomada depende do resultado confirmado da operação existente.

Não mudam os contratos da API, papéis, autoridade do atendimento, idempotência ou regras de transporte. O contexto de navegação aceita somente um UUID de caixa; toda leitura ou alteração continua autorizada pelo servidor no tenant atual.

## Verificação

- Candidato focal: sete arquivos e 117 testes aprovados, incluindo falha de leitura com estado antigo e recuperação com revisões atuais.
- Revisão independente inicial e revisão do reparo: nenhum achado crítico ou importante pendente.
- Composição canônica: TypeScript e build web aprovados.
- `npm test -- --maxWorkers=2`: 301 arquivos e 2.405 testes aprovados, sem falhas; duração 431,14 s.
- Bundle sem achados; contratos públicos, sete notices de terceiros e fronteira Evolution aprovados.
- Os treze arquivos promovidos conferem com os hashes do candidato revisado; `git diff --check` aprovado.

Não há migration nova nem mudança de Compose ou ENV. A baseline permanece `0051_whatsapp_group_events`. CI e imagens precisam corresponder ao mesmo commit da `main`; a instalação no servidor é uma etapa separada.

## Aceite em produção

O teste real usa uma conversa controlada: mensagem recebida → menu ou captura → transferência humana → resposta do atendente → retomada explícita. Conexão, publicação, vínculo e readiness não comprovam entrega.

O acesso ao navegador do executor local falhou antes de abrir os sistemas nesta validação. Portanto, não há novo resultado de produção nem aceite visual registrado para este incremento. Flow e QR delegados, mídia S3 e os demais candidatos do programa não fazem parte desta entrega de interface.
