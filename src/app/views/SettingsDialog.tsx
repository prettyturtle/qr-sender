/**
 * Settings: language, received-file history, and a way out of a bad cache.
 *
 * These three live together because they are the only things in the app that
 * outlive a single transfer. Everything else on screen is about the transfer
 * happening right now; this is about what the device keeps.
 *
 * Built on `<dialog>` for the modal semantics that come with it: focus is
 * trapped, Escape closes, and the rest of the page is inert.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  HISTORY_MAX_BYTES,
  clearHistory,
  deleteHistory,
  historyBytes,
  listHistory,
  readHistory,
  type HistoryEntry,
  type HistoryMeta,
} from '../../platform/storage.js';
import { clearAppCacheAndReload } from '../../platform/appCache.js';
import { formatBytes } from '../estimate.js';
import { LOCALES, localeInfo, useT, type Locale } from '../i18n.js';
import { useAppStore } from '../store.js';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Hand a stored transfer back to the app so it can be shown in the viewer. */
  onOpenEntry: (entry: HistoryEntry) => void;
}

export function SettingsDialog({ open, onClose, onOpenEntry }: SettingsDialogProps): JSX.Element {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const historyEnabled = useAppStore((s) => s.historyEnabled);
  const setHistoryEnabled = useAppStore((s) => s.setHistoryEnabled);

  const [entries, setEntries] = useState<HistoryMeta[]>([]);
  const [used, setUsed] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Callback ref rather than `useRef`: the mount has to trigger the effect that
  // calls `showModal`, and a ref object does not re-render when it is filled.
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setEntries(await listHistory());
    setUsed(await historyBytes());
  }, []);

  useEffect(() => {
    if (dialogEl === null) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  }, [open, dialogEl]);

  useEffect(() => {
    if (!open) return;
    setConfirmingClear(false);
    void refresh();
  }, [open, refresh]);

  const openEntry = useCallback(
    async (receivedAt: number): Promise<void> => {
      const entry = await readHistory(receivedAt);
      if (entry === null) {
        // Evicted between listing and opening. Re-read rather than showing a
        // row that no longer resolves to anything.
        void refresh();
        return;
      }
      onOpenEntry(entry);
      onClose();
    },
    [onOpenEntry, onClose, refresh],
  );

  const remove = useCallback(
    async (receivedAt: number): Promise<void> => {
      await deleteHistory(receivedAt);
      await refresh();
    },
    [refresh],
  );

  const removeAll = useCallback(async (): Promise<void> => {
    await clearHistory();
    setConfirmingClear(false);
    await refresh();
  }, [refresh]);

  const dateFormat = new Intl.DateTimeFormat(localeInfo(locale).code, {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <dialog
      ref={setDialogEl}
      className="settings-dialog"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === dialogEl) onClose();
      }}
    >
      <h2>{t('settings.title')}</h2>

      <section className="settings-section">
        <label htmlFor="settings-lang">{t('app.language')}</label>
        <select
          id="settings-lang"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <div className="settings-row">
          <label htmlFor="settings-history">{t('settings.history')}</label>
          <input
            id="settings-history"
            type="checkbox"
            checked={historyEnabled}
            onChange={(event) => setHistoryEnabled(event.target.checked)}
          />
        </div>
        <p className="settings-note">{t('settings.historyNote')}</p>

        {entries.length === 0 ? (
          <p className="settings-empty">{t('settings.historyEmpty')}</p>
        ) : (
          <>
            <p className="settings-note mono">
              {t('settings.historyUsage', {
                used: formatBytes(used),
                total: formatBytes(HISTORY_MAX_BYTES),
              })}
            </p>
            <ul className="history-list">
              {entries.map((entry) => (
                <li key={entry.receivedAt}>
                  <button
                    type="button"
                    className="history-open"
                    onClick={() => void openEntry(entry.receivedAt)}
                  >
                    <span className="history-name">{entry.name}</span>
                    <span className="history-meta">
                      {formatBytes(entry.size)} · {dateFormat.format(entry.receivedAt)}
                      {entry.integrity === 'mismatch' && ` · ${t('recv.mismatch')}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('common.delete')}
                    onClick={() => void remove(entry.receivedAt)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            {confirmingClear ? (
              <div className="btn-row">
                <button type="button" className="btn btn-sm danger" onClick={() => void removeAll()}>
                  {t('settings.clearConfirm')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmingClear(false)}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmingClear(true)}
              >
                {t('settings.clearAll')}
              </button>
            )}
          </>
        )}
      </section>

      <section className="settings-section">
        <label>{t('settings.app')}</label>
        <p className="settings-note">{t('settings.refreshNote')}</p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={resetting}
          onClick={() => {
            setResetting(true);
            void clearAppCacheAndReload();
          }}
        >
          {resetting ? t('settings.refreshing') : t('settings.refresh')}
        </button>
      </section>

      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </dialog>
  );
}
