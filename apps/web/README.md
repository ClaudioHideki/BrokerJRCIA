# Console web JRC

Aplicação React/Vite da Console JRC. Execute `npm run build` na raiz para validar os projetos TypeScript e gerar o bundle Vite. Para gerar somente o bundle web, use `npm run build:web`; valide o artefato resultante com `npm run test:web:bundle`.

O navegador acessa somente caminhos relativos `/v1` da API JRC. O access token permanece em memória e o refresh fica em cookie HttpOnly; nenhum token é gravado em localStorage, sessionStorage, IndexedDB, URL ou bundle. Variáveis `VITE_*` são recusadas no build porque esta console não necessita de configuração pública injetada no cliente. `JRC_API_PROXY_TARGET` configura apenas o proxy server-side do Vite em desenvolvimento e teste.

Desenvolvimento local no PowerShell, com a API já ativa em `127.0.0.1:3000`:

```powershell
$env:JRC_API_PROXY_TARGET='http://127.0.0.1:3000'
npm --workspace @jrc/web run dev -- --host 127.0.0.1
Remove-Item Env:JRC_API_PROXY_TARGET
```

O E2E usa `vite preview` sobre um bundle recém-gerado e uma composição real da API JRC com PostgreSQL, Redis e provider falso exclusivo de teste. Consulte o [runbook de mesma origem e HTTPS](../../docs/operations/web-console.md) antes de qualquer preparação de ambiente.

O logo local e sua origem estão documentados em [`public/brand/ORIGIN.md`](public/brand/ORIGIN.md).
