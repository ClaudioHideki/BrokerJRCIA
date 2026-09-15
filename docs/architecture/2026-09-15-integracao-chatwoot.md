# Integração SaaS JRC Conversas — execução autorizada

O pedido de 15/09/2026 autoriza desenvolvimento e correções locais. A publicação de imagens no GitHub e a implantação no Dokploy serão solicitadas depois pelo usuário.

Atualização de autorização: o usuário forneceu `ClaudioHideki/BrokerJRCIA` para envio após a entrega local. O escopo passa a incluir upload dos fontes, CI e publicação das imagens para homologação. A implantação no servidor permanece uma etapa posterior.

## Modelo

- JRC é uma organização do broker vinculada à conta 1 do JRC Conversas; administração global é uma identidade separada.
- Cada empresa cliente possui sua organização e sua conta Chatwoot. A combinação instalação/conta tem proprietário único no broker.
- Cada canal WhatsApp possui uma caixa API. Credenciais, contatos, conversas, tarefas e anexos são isolados por organização.
- O provisionamento pode criar recursos ou vincular existentes, com estado persistente e reconciliação após resultado incerto.
- O operador vê somente nomes JRC e capacidades do canal. Metadados privados do motor permanecem no servidor.

## Sequência de execução

1. Migração aditiva do canal Meta para canal genérico, entrada QR autenticada, texto, estados e testes de compatibilidade.
2. Conector Chatwoot persistente, caixas/contas, validação de assinaturas, prevenção de loops, idempotência, retries e fila de falhas.
3. UI de integração por empresa e administração do provisionamento, workers automáticos por partição, rastreabilidade.
4. Mídia privada e regras de envio Meta; preparação para homologação dos ativos autorizados.
5. Login solicitado por e-mail/senha no modo servidor, configuração HTTPS, backup/restore, verificações da distribuição e preparação Docker.
6. Regressão unitária, HTTP, PostgreSQL, build e verificação visual. Publicação e testes externos dependentes de domínio/credenciais são registrados separadamente.

## Invariantes de entrega

- Confirmar webhook somente após persistir; repetir evento não repete mensagem.
- Resposta de atendente nunca encaminha nota privada nem eco da integração.
- Resultado de envio incerto é conciliado, sem reenvio cego.
- Todo acesso, inclusive arquivo e webhook, resolve a empresa pelo vínculo armazenado e valida seus limites.
- Uma falha no destino não bloqueia outras empresas. Trabalho pendente sobrevive a reinícios.
- A lista de empresas é descoberta por função mínima de agendamento, sem dar leitura global das tabelas tenant ao worker.
- Segredos não entram no frontend, logs, artefatos nem documentação.
- Anexos desta implantação ficam cifrados no PostgreSQL, com limite de 16 MiB por arquivo (imagens 5 MiB; stickers 500 KiB) e cota padrão de 1 GiB por empresa. O backup transacional inclui os arquivos. Referências de download ficam vinculadas ao canal e não expõem URLs de mídia ao cliente.
- Nenhuma evidência local é apresentada como homologação Meta, migração de histórico ou disponibilidade do servidor.
