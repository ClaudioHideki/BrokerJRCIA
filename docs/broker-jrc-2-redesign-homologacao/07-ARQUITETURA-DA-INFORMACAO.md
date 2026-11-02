# 07 — Arquitetura da informação

Proposta incremental apoiada no registro atual `apps/web/src/layout/navigation.ts` e em `app/App.tsx`. A navegação abaixo é recomendação de pesquisa, não renomeação aplicada ao produto.

## Dois contextos explícitos

**Empresa:** atuação dentro da organização ativa; OWNER, ADMIN, OPERATOR e VIEWER. O servidor determina autorização efetiva. A busca lateral atual filtra Chaves de API para OWNER/ADMIN, mas a presença de outras páginas não permite qualquer mutação.

**Plataforma JRC:** sessão staff própria, SUPER_ADMIN e SUPPORT; rotas `/jrc/*`, cliente de plataforma e motivos de operação. “Empresa selecionada para inspeção” não é impersonação nem troca implícita da sessão tenant. Nunca reunir dados multitenant no console da empresa por conveniência visual.

## Navegação de empresa recomendada

| Grupo | Destino | Rota atual preservada | Regra |
|---|---|---|---|
| Operação | Visão geral | `/dashboard` | Resumo, empresa e período explícitos. |
| Operação | Conexões e caixas | `/channels` | Porta de entrada para QR, Meta, central e vínculo humano/bot. |
| Operação | Conversas | `/mensagens` | Mensagens e atendimento, conforme capabilities/permissões. |
| Operação | Saúde operacional | `/operations/health` | Primeiro diagnóstico transversal, leitura e encaminhamento. |
| Automação | Flows e automações | `/automations` | Criação, edição, versões e instalação. |
| Automação | Execuções | `/automation-executions` | Destino já existe; promover descoberta pode exigir item no registro. |
| Integração | Centrais de atendimento | `/integracoes` | JRC Conversas/Chatwoot autorizado; configuração e diagnóstico. |
| Integração | API e webhooks | `/api-webhooks` | Contratos, modos e documentação; não prometer ações sem UI. |
| Integração | Chaves de API | `/chaves-api` | OWNER/ADMIN; segredo exibido conforme fluxo atual. |
| Gestão | Relatórios | `/relatorios` | Período e semântica de contagem preservados. |
| Gestão | Uso e limites | `/uso-custos` | Usar custos somente onde houver medição real. |
| Administração | Minha empresa e limites | `/minha-empresa` | Estado efetivo retornado pelo servidor. |
| Administração | Credenciais de automação | `/credentials` | Diferenciar das chaves públicas de API. |
| Administração | Provisionamento | `/provisionamento` | Operação assistida/de lote, não entrada diária de todos os perfis. |
| Ajuda | Suporte | `/suporte` | Histórico e solicitação contextual com IDs técnicos sanitizados. |
| Ajuda | Configurações | `/configuracoes` | Diretório de configuração, não segunda sidebar com todas as tarefas. |

“Diagnóstico por regras” (`/brain`) pode continuar disponível na busca/ajuda enquanto seu conteúdo for revisado. Não promover como IA nem como central de incidentes. A proposta de agrupamento não precisa ser aplicada integralmente no piloto.

## Navegação de plataforma

Preservar os sete destinos existentes: Visão geral `/jrc`; Grupos econômicos `/jrc/grupos`; Empresas `/jrc/empresas`; Usuários e acessos `/jrc/usuarios`; Planos e limites `/jrc/planos`; Monitoramento `/jrc/monitoramento`; Suporte `/jrc/suporte`.

O workspace da empresa selecionada reúne visão geral, usuários, plano, canais, Chatwoot, monitoramento e ações de lifecycle. O contexto selecionado e o motivo da operação devem permanecer visíveis. A proposta não cria uma sessão SUPER_ADMIN de empresa nem retira o gate de escrita staff.

## Hierarquia do canal

`Conexões e caixas → canal → Visão geral / Configurações WhatsApp / Histórico operacional / Atendimento / Flow / Histórico e grupos`, conforme provider e capacidades. As abas atuais são adaptativas; não exibir uma aba impossível apenas para manter simetria.

A visão geral responde, separadamente: qual o provider; qual o estado da sessão; qual o número confirmado; qual o destino humano; qual automação está vinculada; qual evidência de transporte foi observada. Configurar, ativar, aprovar identidade, conectar e comprovar entrega são etapas distintas.

## Hierarquia da saúde operacional

1. Contexto e última consulta: empresa, horário, atualização automática/manual e erro de atualização.
2. Resultado global reportado e limite: “Resumo dos sinais consultados”; não modificar a agregação do servidor silenciosamente.
3. Atenções: entrega incerta, entrega com falha, fila atrasada e workers vencidos; sem somar unidades diferentes.
4. Camadas: infraestrutura; processamento; canais/destinos; resultados históricos de jobs/execuções.
5. Encaminhamento: detalhes existentes de integração, canal, execução ou suporte. Código técnico é informação secundária de diagnóstico.

Busca deve aceitar termos do usuário e técnicos: WhatsApp, QR, Evolution, central, Chatwoot, caixa, webhook, fila, falha, incerto, reconciliação. Exibir termo comercial principal não exige apagar o identificador técnico no diagnóstico.

## Estados e rotas de compatibilidade

Manter redirects `/conexoes`, `/conexoes/nova`, `/conexoes/:id`, `/providers`, `/whatsapp-oficial` e `/flows`. Não inferir que telas em `/legacy/*` são o fluxo principal. Links antigos continuam úteis para favoritos e suporte.

Todas as áreas devem distinguir: carregando; vazio válido; parcialmente disponível; sem permissão; indisponível; resposta inválida; atualização vencida; erro com referência segura; recurso removido. Não cadastrar um destino proposto no menu antes de existir rota, capability e experiência de erro.

## Critério de aprovação futura

Operador encontra o canal e o problema em até dois encaminhamentos a partir de Saúde operacional; leitor não encontra uma ação que muta estado como se tivesse autorização; troca de empresa limpa contexto anterior; origem/período dos números são legíveis; o nome de uma tela corresponde ao item de navegação. Medir esses critérios com tarefas sintéticas e pessoas representativas; ainda não medido.
