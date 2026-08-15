/**
 * The locale registry: message catalogues, lookup, and detection.
 *
 * Deliberately free of any store import. The settings store needs
 * `detectLocale()` for its initial value, and if that lived alongside the React
 * hook the two modules would form a cycle — one that surfaces as
 * "cannot access LOCALES before initialization" only in whichever order the
 * bundler happens to evaluate them.
 */

import { ko, type MessageKey, type Messages } from './ko.js';
import { en } from './en.js';
import { ja } from './ja.js';
import { zhHans } from './zh-Hans.js';
import { zhHant } from './zh-Hant.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { de } from './de.js';
import { it } from './it.js';
import { pt } from './pt.js';
import { ru } from './ru.js';
import { tr } from './tr.js';
import { vi } from './vi.js';
import { id } from './id.js';
import { hi } from './hi.js';
import { ar } from './ar.js';

export type { MessageKey, Messages };

export type Locale =
  | 'ko'
  | 'en'
  | 'ja'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'pt'
  | 'ru'
  | 'tr'
  | 'vi'
  | 'id'
  | 'hi'
  | 'ar';

export interface LocaleInfo {
  code: Locale;
  /** Endonym: a language picker is useless in a language you cannot read. */
  label: string;
  dir: 'ltr' | 'rtl';
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'ko', label: '한국어', dir: 'ltr' },
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ja', label: '日本語', dir: 'ltr' },
  { code: 'zh-Hans', label: '简体中文', dir: 'ltr' },
  { code: 'zh-Hant', label: '繁體中文', dir: 'ltr' },
  { code: 'es', label: 'Español', dir: 'ltr' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', dir: 'ltr' },
  { code: 'it', label: 'Italiano', dir: 'ltr' },
  { code: 'pt', label: 'Português', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe', dir: 'ltr' },
  { code: 'vi', label: 'Tiếng Việt', dir: 'ltr' },
  { code: 'id', label: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'hi', label: 'हिन्दी', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
];

const DICTS: Record<Locale, Messages> = {
  'ko': ko,
  'en': en,
  'ja': ja,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  'es': es,
  'fr': fr,
  'de': de,
  'it': it,
  'pt': pt,
  'ru': ru,
  'tr': tr,
  'vi': vi,
  'id': id,
  'hi': hi,
  'ar': ar,
};

export function localeInfo(locale: Locale): LocaleInfo {
  return LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  // Falling back to English rather than the key itself: an untranslated string
  // is still readable, a raw key is not.
  let out: string = DICTS[locale]?.[key] ?? DICTS.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** Match the browser's preferences, honouring script subtags for Chinese. */
export function detectLocale(): Locale {
  const tags = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language ?? '']);
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('zh')) {
      return /hant|tw|hk|mo/.test(tag) ? 'zh-Hant' : 'zh-Hans';
    }
    const base = tag.split('-')[0];
    const hit = LOCALES.find((l) => l.code.toLowerCase() === base);
    if (hit !== undefined) return hit.code;
  }
  return 'en';
}

/**
 * Durations are built from message keys rather than `Intl.RelativeTimeFormat`
 * so the unit words stay in the same dictionary as everything else and a new
 * locale needs no code change.
 */
export function formatDuration(seconds: number, locale: Locale): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return translate(locale, 'time.second', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return translate(locale, 'time.minute', { n: m });
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0
    ? translate(locale, 'time.hour', { n: h })
    : translate(locale, 'time.hourMinute', { h, m: rest });
}
