import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { applyLocale, I18nProvider, loadLocale } from './services/i18n';
import { applyThemePreferences, loadThemePreferences } from './services/theme';

applyThemePreferences(loadThemePreferences());
applyLocale(loadLocale());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
