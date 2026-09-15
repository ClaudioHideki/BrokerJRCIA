import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Elemento raiz da Console JRC não encontrado.');
}

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
