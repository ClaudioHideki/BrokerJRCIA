import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EmbedPage } from './EmbedPage.js';

const element = document.getElementById('root');
if (!element) throw new Error('Elemento raiz JRC ausente.');
createRoot(element).render(<StrictMode><EmbedPage /></StrictMode>);
