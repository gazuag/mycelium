import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { registerMyceliumServiceWorker } from './services/web-push';

void registerMyceliumServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
);
