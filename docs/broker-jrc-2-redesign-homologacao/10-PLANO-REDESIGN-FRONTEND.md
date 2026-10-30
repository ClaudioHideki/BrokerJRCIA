# Redesign incremental e primeira entrega

Escopo autorizado: missão Broker JRC2.0 fornecida em30/10/2026. Primeiro incremento na branch `codex/broker-jrc-2-redesign-homologacao-20261030`, base d1b66a. Sem publicação automática.

## Decisão de projeto

Reutilizar React/Vite/react-router, @jrc/ui e tokens existentes. Começar pela Saúde operacional, com dados do GET /v1/operations/health, sem inventar dados ou abrir operações de replay. Essa decisão de implementação é do executor, baseada nos incidentes comprovados e na sequência autorizada pelo usuário.

Alternativas consideradas: reconstruir todo o shell agora aumentaria risco de regressão e não resolveria diagnóstico; adicionar uma página separada duplicaria navegação/contratos. Evoluir a rota existente permite provar a experiência antes de expandir.

## Piloto

- Separar infraestrutura/processamento, canais/integrações e pendências acumuladas.
- Explicar que processo disponível e destino aprovado não comprovam entrega.
- Cada componente expõe métrica, unidade, fonte/escopo temporal, observação e código técnico opcional.
- Alertas com orientação em português e links para rotas existentes; sem afirmar causa específica a partir de contador agregado.
- UNKNOWN significa resultado incerto, nunca não enviado ou autorização de retry.
- Mostrar loading inicial, consulta em andamento, vazio, falha inicial e dados anteriores desatualizados.
- Atualização a cada30s, sem sobrepor requests, parar após unmount e não aplicar resposta de outro contexto.
- Tema claro/escuro limitado ao piloto usando tokens centralizados; sem declarar guia institucional definitivo.
- Responsividade, foco e semântica; axe automatizado e revisão visual local. Demonstração sempre marcada como sintética.

## Limites

Não corrige nesta primeira tela a durabilidade B02, custódia física B03, engine, infraestrutura ou integração externa. O backend atual continua reportando contadores acumulados. A nova apresentação deve explicitar essa limitação, não convertê-los em incidentes recentes por suposição. A correção SQL da saúde/escopo será incremento próprio com teste PG. Nenhum novo endpoint ou migração é necessário para este piloto.

## Expansão

Após aceite do piloto: integrar navegação por perfil, operações da central, canais/QR, destinos/credenciais, engines, mídias e portal dev. Cada área terá mapeamento frontend/backend, teste de permissão/erro/vazio e evidência visual. Legado só sai após equivalência comprovada. Fases posteriores seguem16-PLANO-DE-IMPLEMENTACAO.md; não são implicitamente concluídas pelo piloto.
