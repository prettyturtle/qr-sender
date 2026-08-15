import { useEffect, useState } from 'react';
import { LOCALES, useT, type Locale } from './i18n.js';
import { useAppStore } from './store.js';
import { SendView } from './views/SendView.js';
import { ReceiveView } from './views/ReceiveView.js';
import { pruneTransfers } from '../platform/storage.js';

type Tab = 'send' | 'receive';

function initialTab(): Tab {
  const hash = globalThis.location?.hash.replace('#', '');
  return hash === 'receive' ? 'receive' : 'send';
}

export function App(): JSX.Element {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const [tab, setTab] = useState<Tab>(initialTab);

  // `replaceState` rather than assigning to `location.hash`: the latter pushes a
  // history entry per tab switch, so Back would leave the URL and the rendered
  // view disagreeing. The hash still deep-links (`#receive` on the onboarding QR),
  // so external changes are honoured too.
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  useEffect(() => {
    const onHashChange = (): void => setTab(initialTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void pruneTransfers();
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <h1>{t('app.name')}</h1>
          <p>{t('app.tagline')}</p>
        </div>
        <select
          className="lang-select"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
          aria-label={t('app.language')}
        >
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </header>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'send'}
          onClick={() => setTab('send')}
        >
          {t('app.send')}
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'receive'}
          onClick={() => setTab('receive')}
        >
          {t('app.receive')}
        </button>
      </div>

      <main className="content">{tab === 'send' ? <SendView /> : <ReceiveView />}</main>

      <p className="footnote">{t('app.privacy')}</p>
    </div>
  );
}
