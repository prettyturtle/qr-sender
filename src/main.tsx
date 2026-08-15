import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app/App.js';
import './app/styles.css';

registerSW({ immediate: true });

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
