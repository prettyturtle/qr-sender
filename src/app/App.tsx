import { useEffect, useState } from 'react';
import { localeInfo, useT } from './i18n.js';
import { useAppStore } from './store.js';
import { SendView } from './views/SendView.js';
import { ShareDialog } from './views/ShareDialog.js';
import { SettingsDialog } from './views/SettingsDialog.js';
import { Viewer } from './views/Viewer.js';
import type { HistoryEntry } from '../platform/storage.js';
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
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sharing, setSharing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** A stored transfer being re-opened from history; takes over the main area. */
  const [viewing, setViewing] = useState<HistoryEntry | null>(null);

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
          {/* Language moved into settings: it is set once and then never
              touched, so a permanent control the width of the longest language
              name was paying masthead space every session for a decision made
              in the first. */}
          <button
            type="button"
            className="btn btn-sm btn-icon"
            onClick={() => setSettingsOpen(true)}
            aria-label={t('settings.title')}
            title={t('settings.title')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm7.4-2.6.1-.9-.1-.9 1.9-1.5a.5.5 0 0 0 .12-.63l-1.8-3.12a.5.5 0 0 0-.6-.22l-2.24.9a7.3 7.3 0 0 0-1.55-.9l-.34-2.38a.5.5 0 0 0-.5-.43h-3.6a.5.5 0 0 0-.5.43l-.34 2.38c-.55.23-1.07.53-1.55.9l-2.24-.9a.5.5 0 0 0-.6.22l-1.8 3.12a.5.5 0 0 0 .12.63L4.6 11.1l-.1.9.1.9-1.9 1.5a.5.5 0 0 0-.12.63l1.8 3.12a.5.5 0 0 0 .6.22l2.24-.9c.48.37 1 .67 1.55.9l.34 2.38a.5.5 0 0 0 .5.43h3.6a.5.5 0 0 0 .5-.43l.34-2.38c.55-.23 1.07-.53 1.55-.9l2.24.9a.5.5 0 0 0 .6-.22l1.8-3.12a.5.5 0 0 0-.12-.63l-1.9-1.5Z"
                fill="currentColor"
              />
            </svg>
          </button>
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

      <main className="content">
        {viewing !== null ? (
          <Viewer
            name={viewing.name}
            mime={viewing.mime}
            data={viewing.data}
            integrity={viewing.integrity}
            onReset={() => setViewing(null)}
          />
        ) : tab === 'send' ? (
          <SendView />
        ) : (
          <ReceiveView />
        )}
      </main>

      <p className="footnote">{t('app.privacy')}</p>

      <ShareDialog open={sharing} onClose={() => setSharing(false)} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenEntry={setViewing}
      />
    </div>
  );
}
