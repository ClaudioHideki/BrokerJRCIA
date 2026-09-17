import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Elemento raiz da Console JRC não encontrado.');
}

if (window.location.pathname.startsWith('/embed/chatwoot/')) {
  // Development SPA fallback also chooses the restricted entry before loading console code.
  await import('./embed/main.js');
} else {
const { App } = await import('./app/App.js');
const demo =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1'
    ? await import('./broker/demo.js')
    : null;
if (demo) {
  const banner = document.createElement('div');
  banner.className = 'demo-ribbon';
  banner.textContent = 'DEMONSTRAÇÃO VISUAL · Dados simulados · Nenhuma conta ou mensagem real';
  rootElement.before(banner);
}
createRoot(rootElement).render(
  <StrictMode>
    <App {...(demo ? { client: demo.createDemoClient() } : {})} />
  </StrictMode>,
);
}
