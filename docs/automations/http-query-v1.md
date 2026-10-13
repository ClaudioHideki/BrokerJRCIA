# Consulta HTTPS GET delimitada

O administrador cadastra uma credencial HTTP por nome em Credenciais, informa autenticação e de um a vinte origins HTTPS públicos permitidos. O editor seleciona nome/tipo/revisão sem mostrar segredo ou pedir UUID. Origins não contêm caminho, query ou credenciais. Cada edição de política usa a revisão atual e preserva o segredo criptografado. Após uma mudança, selecione o nome novamente nos blocos antes de publicar.

O perfil novo httpConfigVersion:1 permite GET para URL fixa HTTPS em hostname DNS público, sem IP literal, usuário/senha, query, fragmento ou template na URL. Valores de variáveis entram somente nos parâmetros separados e são codificados por URLSearchParams. Há até vinte parâmetros, 30 segundos, duas novas tentativas de GET e 32 KiB de resposta. Headers/body livres e redirecionamentos não fazem parte desse perfil.

Validação, simulação e publicação usam o mesmo schema e política do motor; a publicação revalida credencial, origem e revisão na transação final com FOR SHARE. Revogar/rotacionar/alterar política usa FOR UPDATE e CAS. O despacho revalida a credencial atual antes de rede e reutiliza IO_HTTP/http-effect/safe-http, DNS público fixado e TLS.

A simulação recebe uma resposta fictícia explicitamente para o bloco HTTP atualmente em espera. Pode seguir success/client_error/server_error/timeout/unknown sem rede, segredo ou confirmação externa. Respostas de outro bloco ou acima de 32 KiB são rejeitadas.

Payloads históricos sem marker preservam o comportamento existente, incluindo UNKNOWN de mutações. Marker inválido nunca é reinterpretado como histórico. A criação de consultas GET está habilitada após revisão independente e testes focais. A instalação requer a imagem aprovada no CI da main; a jornada real na caixa conectada pertence à homologação posterior.

Não há migration, variável ENV, Compose, dependência ou executor novo. A política é por empresa e armazenada na metadata da credencial existente.
