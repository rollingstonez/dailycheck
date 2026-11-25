import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { seedIfEmpty } from './db';
import './styles.css';

registerSW({ immediate: true });

// 브라우저가 저장 공간을 임의로 지우지 않도록 요청
navigator.storage?.persist?.();

seedIfEmpty().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
