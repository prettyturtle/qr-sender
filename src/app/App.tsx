import { useEffect, useState } from 'react';
import { LOCALES, localeInfo, useT, type Locale } from './i18n.js';
import { useAppStore } from './store.js';
import { SendView } from './views/SendView.js';
import { ShareDialog } from './views/ShareDialog.js';
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
  const [sharing, setSharing] = useState(false);

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
    const info = localeInfo(locale);
    document.documentElement.lang = info.code;
    // Arabic reverses the whole layout; leaving `dir` at ltr would mirror
    // nothing and read as broken rather than translated.
    document.documentElement.dir = info.dir;
  }, [locale]);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <h1>{t('app.name')}</h1>
          <p>{t('app.tagline')}</p>
        </div>
        <div className="masthead-actions">
          {/* Icon rather than a word: the label is the widest thing in the
              masthead in several languages, and it sits next to a language
              picker that has to stay readable. The accessible name still
              carries the full text. */}
          <button
            type="button"
            className="btn btn-sm btn-icon"
            onClick={() => setSharing(true)}
            aria-label={t('share.title')}
            title={t('share.title')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .17 1L8.8 8.6a3 3 0 1 0 0 6.8l6.37 3.6A3 3 0 1 0 18 16a3 3 0 0 0-2.06.82L9.9 13.4a3 3 0 0 0 0-2.8l6.04-3.42A3 3 0 0 0 18 8Z"
                fill="currentColor"
              />
            </svg>
          </button>
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
        </div>
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

      <ShareDialog open={sharing} onClose={() => setSharing(false)} />
    </div>
  );
}
