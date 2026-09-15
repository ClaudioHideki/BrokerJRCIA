# Validação do Docker Compose da Fase 0

**Data:** 03/09/2026

**Ambiente externo:** Windows, Docker 29.7.2 e Docker Compose 5.4.0.

## Comando executado

```powershell
docker compose --env-file infra/baseline/.env.example -f infra/baseline/compose.yaml config
```

## Resultado

- configuração processada sem erro;
- serviços encontrados: `evolution`, `postgres` e `redis`;
- imagens fixadas: `jrc-evolution-engine:phase0-local`, `postgres:16.4-alpine` e `redis:7.4.0-alpine`;
- porta da Evolution limitada a `127.0.0.1:8080`;
- volumes nomeados para instâncias, PostgreSQL e Redis;
- nenhuma credencial real utilizada.

Esta evidência valida a sintaxe e a interpolação do Compose. Ela não comprova ainda o build da imagem nem a saúde dos containers; isso pertence ao smoke test da próxima tarefa.
