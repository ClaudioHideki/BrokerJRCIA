# Runbook da Console Web JRC: HTTPS e mesma origem

## Escopo

Este runbook descreve a topologia segura para preparar a Console Web da Fase 1 — Incremento 2. Ele não autoriza deploy. A liberação de um ambiente continua dependendo de uma tarefa de release aprovada e de secrets fornecidos pelo gerenciador do ambiente.

## Topologia obrigatória

Um único origin HTTPS público deve atender navegador e API, por exemplo `https://console.example.invalid`:

- `/` e as rotas da SPA servem os arquivos de `apps/web/dist`, com fallback para `index.html`;
- `/v1/` é encaminhado à API JRC privada;
- a Evolution permanece somente na rede interna do provider e nunca recebe rota, host ou porta pública;
- `/documentation` permanece desabilitado em produção; seu opt-in aceita apenas bind loopback interno.

O proxy termina TLS, preserva `Host` e `Origin` e envia informações de cliente somente por proxies listados em `TRUSTED_PROXY_CIDRS`. A aplicação ignora `X-Forwarded-For` de origens não confiáveis. Não reescreva `/v1` para uma API Evolution nem exponha a chave administrativa do provider.

## Configuração de produção

Defina no gerenciador de secrets, nunca em arquivo versionado:

- `BROWSER_CSRF_SECRET`: valor aleatório com pelo menos 32 bytes, exclusivo para CSRF;
- `CONSOLE_ALLOWED_ORIGINS`: lista de origins HTTPS exatos, sem wildcard, path, query ou credenciais;
- `CONSOLE_COOKIE_SECURE=true`;
- os demais secrets obrigatórios descritos em `.env.example`, todos distintos entre si.

Os cookies de produção são `__Host-jrc_refresh` (`HttpOnly`) e `__Host-jrc_csrf` (legível pelo cliente), ambos `Secure`, `SameSite=Strict` e `Path=/`. O refresh não integra respostas JSON. Toda rota `/v1/console/auth/*` valida `Origin`, e as rotas baseadas em cookie também exigem `X-CSRF-Token` assinado.

## Headers e cache

Configure a resposta do HTML com uma CSP equivalente a:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
```

A resposta do HTML também deve negar capacidades que a Console Web não utiliza:

```text
Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()
```

As allowlists vazias são obrigatórias neste incremento. Qualquer funcionalidade futura que precise dessas capacidades exige revisão de segurança e uma permissão mínima e explícita antes do deploy.

Também habilite HSTS no terminador TLS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e proteção contra framing. Sirva assets com hash usando cache imutável; sirva `index.html` com revalidação. Respostas `/v1`, autenticação, cookies e desafios permanecem `Cache-Control: no-store` e `Pragma: no-cache`.

## Build e validação local

Na raiz do repositório:

```powershell
npm ci
npm run build
npm run test:web:bundle
npm run security:notices
npm run test:web
```

O build falha se o ambiente contiver qualquer variável `VITE_*`. A console usa URLs relativas; `JRC_API_PROXY_TARGET` é uma opção server-side exclusiva do Vite local e nunca entra no bundle.

Para executar o E2E, forneça somente na sessão `TEST_DATABASE_ADMIN_URL` e `TEST_REDIS_URL` apontando para recursos locais de teste. O comando recompila o bundle, serve-o com `vite preview`, cria banco/tenant sintético e remove seus recursos no teardown:

```powershell
npm run test:e2e
```

Nunca use banco, Redis, número WhatsApp ou credenciais de cliente nesse fluxo.

## Verificações antes de release

1. Confirmar TLS válido, HSTS e origin único.
2. Confirmar que `CONSOLE_ALLOWED_ORIGINS` contém apenas o origin publicado.
3. Confirmar cookies `__Host-`, `Secure`, `SameSite=Strict`, `Path=/` e refresh `HttpOnly`.
4. Confirmar CSP sem `unsafe-inline` e requests do browser somente para o próprio origin.
5. Confirmar o header `Permissions-Policy` no ambiente publicado e verificar que capacidades não utilizadas possuem allowlist vazia.
6. Confirmar que Evolution, Redis, PostgreSQL e Swagger não têm publicação externa.
7. Executar os gates completos do plano e revisar o inventário de rotas e a auditoria do incremento.
8. Confirmar que `THIRD_PARTY_NOTICES.txt` acompanha o bundle publicado.
9. Configurar `AUDIT_FINGERPRINT_SECRET` no GitHub Actions com valor aleatório de pelo menos 16 caracteres, preferencialmente 32 ou mais, sem expor seu valor.

## Diagnóstico seguro

Use `X-Request-Id` para correlação. Não copie para tickets ou logs tokens, cookies, API keys, senhas, telefones, QR Codes, pairing codes ou payloads do provider. Para respostas perdidas de emissão ou conexão, siga o fluxo seguro da UI: revogar/reemitir a chave ou iniciar uma nova intenção de conexão, sem tentar recuperar o segredo anterior.
