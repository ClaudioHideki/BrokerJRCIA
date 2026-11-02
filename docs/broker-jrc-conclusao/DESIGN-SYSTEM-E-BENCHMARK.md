# Produto, navegação e referências

Mantidos React, rotas existentes e tokens `@jrc/ui`; nenhuma biblioteca ou dependência adicionada. O inventário em `MATRIZ-TELAS-JORNADAS.csv` cobre rotas registradas, aliases, legado, abas, drawers e embed. Inventariar não significa redesenhar ou homologar todas essas telas.

## Jornada entregue

`DeliveryDiagnostics` passa de tabela larga para cartões com quantidade, explicação e orientação. Detalhes técnicos ficam em expansão; IDs extensos quebram linha. Cores vêm dos tokens JRC, inclusive aviso UNKNOWN em tema escuro. Consulta mostra seu horário e intervalo **de criação das tarefas**, não horário presumido do incidente. O escopo é toda a empresa, inclusive vínculos desativados; não é saúde filtrada do canal atual.

Administração: aba Monitoramento de `CompanyWorkspace` consulta o diagnóstico real da empresa com SUPER_ADMIN/SUPPORT e justificativa/auditoria existentes. Sete abas preservadas. A ação de abrir integração leva à aba real e atualiza foco; não simula resolução. Painel da empresa reutiliza o diagnóstico e mantém loading, vazio, sem permissão, erro de consulta e UNKNOWN distintos. Erro não vira contador zero; reler não envia mensagem.

Troca de empresa desmonta/reinicia o componente; respostas da geração antiga são descartadas. Backend continua autoridade de acesso. O frontend não libera QR, replay ou envio por esconder botão.

## Referências consultadas em 01/11/2026

| Problema JRC | Padrão observado / adaptação | Fonte / limite |
|---|---|---|
| Administração perde contexto da empresa | Contexto parceiro/cliente explícito; conservar nome e escopo da consulta | [360dialog Partner Hub](https://docs.360dialog.com/partner/partner-hub); referência documental, não teste de seu painel autenticado |
| Sessão conectada confundida com entrega | Sessões e operações separadas; JRC distingue sessão, identidade, vínculo e entrega | [WAHA Dashboard](https://waha.devlike.pro/docs/how-to/dashboard/); não prova suporte de capacidade JRC |
| Contratos de caixa/webhooks | Endpoints com Account e eventos explícitos; verificar fork real em vez de supor equivalência | [Chatwoot Webhooks](https://developers.chatwoot.com/api-reference/webhooks/add-a-webhook); documentação corrente não certifica versão LAB2/CCLX |

Nenhuma marca, código proprietário ou capacidade foi copiada dessas referências. Twilio/Astra/QuePasa não foram apresentados como produtos inspecionados neste incremento.

## Validação e pendências

Componentes testam os dez códigos, ações, metadados, permissões, troca de contexto e falhas. A revisão independente corrigiu a orientação HISTORY_UNAVAILABLE: a falha é na importação da central, não na origem já armazenada.

Os quatro testes E2E móveis anteriormente pulados foram habilitados e adaptados ao menu real. Contagens e resultado final estão em `TESTES-E-EVIDENCIAS.md`. Provider do E2E é sintético; isso não homologa QR físico ou LAB2 completo.

Ainda exige incremento: jornadas completas de usuários/planos/fleet/detalhes de fila, todos os estados de cada tela, tabelas individuais quando o endpoint oferecer esse contrato, screenshots comparativas em 320/390/768/1280 e desktop amplo, zoom/leitor de tela e avaliação WCAG 2.2 AA. Axe e teclado do recorte não equivalem à certificação integral. Não declarar o redesign inteiro concluído por esta primeira jornada.
