/**
 * Translation entry point. Re-exports the registry so callers have one import,
 * and adds the React binding — which is the only part that needs the store.
 */

import { useAppStore } from './store.js';
import { translate, type MessageKey } from './locales/registry.js';

export {
  LOCALES,
  formatDuration,
  localeInfo,
  translate,
  detectLocale,
  type Locale,
  type LocaleInfo,
  type MessageKey,
  type Messages,
} from './locales/registry.js';

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useT(): Translate {
  const locale = useAppStore((s) => s.locale);
  return (key, vars) => translate(locale, key, vars);
}
