# Diagnóstico do login administrativo e QR local

Em 14/09/2026, as capturas mostraram duas situações diferentes:

- `admin@jrc.local` estava sendo usado em `/login`, exclusivo de clientes. A mesma credencial foi validada em `/jrc` com TOTP, sem reset de senha ou remoção do segundo fator. Foi adicionado link explícito entre o login de clientes e a administração.
- A instância `welton` foi criada quando o motor não estava em execução, ficando em `PROVISIONING_FAILED`. Esse estado não possui sessão nem QR recuperável. Foi adicionada explicação e orientação na tela, removendo o painel vazio. O registro original é preservado.

Dois testes novos reproduziram a ausência dessas orientações antes da correção. Após a mudança, os 23 testes dos dois arquivos de interface passaram; `npm run typecheck` e `git diff --check` também passaram. O frontend local foi reconstruído e reiniciado, preservando banco, usuários e demais serviços.

A validação após reinício também revelou que CONNECTING ocultava o botão de pareamento, embora o backend já permitisse nova intenção após verificar a operação/lease ativa. Foi adicionado teste de recuperação após reload e habilitado Tentar conexão novamente nesse estado. O backend continua juntando chamadas durante uma operação ativa e controlando concorrência; não foi alterado. A verificação final das três suítes de interface passou com 26 testes, além da tipagem.

## Construção do motor para teste local

O Docker dispõe de aproximadamente 4 GB. A compilação padrão foi interrompida e uma tentativa com heap de 768 MB confirmou falta de memória. A receita local `.sessions/demo/engine.Dockerfile` deriva do Dockerfile do submódulo preservado; dentro da imagem, mantém apenas a entrada de servidor `src/main.ts`, saída CommonJS sem source maps, preservando a cópia de traduções. A checagem TypeScript continua sendo executada. Heap de 1536 MB e limites de paralelismo reduzem a pressão da compilação. Essa receita é para demonstração, não substitui uma imagem de produção revisada.

```powershell
docker build -f .sessions/demo/engine.Dockerfile -t jrc-evolution-engine:fa09d378-local upstream/evolution-api
docker compose -p jrc-demo-local --env-file .sessions/demo/.env -f infra/dokploy/compose.yaml -f .sessions/demo/compose.local.yaml up -d evolution
```

O motor usa rede privada e banco dedicado. O override local desativa telemetria e adiciona volume de sessões. Não publicar sua porta diretamente. As credenciais estão no ambiente ignorado pelo Git.

## Procedimento de pareamento

Depois que o motor estiver operacional, entrar como cliente Alfa, selecionar a empresa, criar uma conexão nova e clicar em Conectar com QR Code selecionado. Uma falha terminal anterior não deve ser convertida artificialmente em conexão criada por alteração direta de banco.

O QR é temporário e só aparece na resposta da operação autenticada. Ao recarregar a página, pode ser necessário Gerar novo desafio. Ler no celular em WhatsApp → Aparelhos conectados → Conectar um aparelho. A geração do QR não significa que o número está conectado; isso só acontece após o usuário parear e o status confirmar a conexão. Não foram autorizados envios reais.

## Resultado observado

A imagem `jrc-evolution-engine:fa09d378-local` foi construída, as migrations do banco dedicado foram aplicadas e o motor retornou HTTP 200 pela rede privada. A primeira tentativa permaneceu em CONNECTING com count=0; após reinicialização controlada do motor, o teste no navegador confirmou a imagem QR real carregada na conexão `welton-qr`, na Empresa Demo Alfa. Não houve pareamento nem envio de mensagens. O diagnóstico temporário foi removido; logs do motor ficaram em ERROR/WARN e Baileys em error.

Conexão para o teste: http://127.0.0.1:8088/conexoes/2991b302-8b14-46c2-8881-6a0eb1309bd5 . O usuário deve entrar no portal com o cliente Alfa, abrir essa conexão e gerar novo desafio. O QR usado para verificar a renderização é efêmero e não foi salvo em arquivo.
