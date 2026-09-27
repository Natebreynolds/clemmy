/**
 * A device the owner can recognise, from what a phone or browser told us.
 *
 * Pairing records the browser's user-agent string as the device label, which
 * is honest but unreadable: six rows of "Mozilla/5.0 (iPhone; CPU iPhone OS
 * 18_0 like Mac OS X)…" tell nobody which phone is theirs. This turns that
 * string into "iPhone · Clem app" or "Mac · Chrome"; a label the owner or the
 * native shell chose is kept as written.
 */
export type DevicePlatform = 'iphone' | 'ipad' | 'mac' | 'android' | 'windows' | 'other';
export type DeviceApp = 'clem' | 'safari' | 'chrome' | 'firefox' | 'browser' | 'unknown';

export interface DeviceName {
  /** Short, recognisable: "iPhone · Clem app", "Mac · Chrome", or the given label. */
  name: string;
  platform: DevicePlatform;
  app: DeviceApp;
  /** True when the name was derived from a user-agent string rather than chosen. */
  derived: boolean;
}

const PLATFORM_WORDS: Record<DevicePlatform, string> = {
  iphone: 'iPhone', ipad: 'iPad', mac: 'Mac', android: 'Android phone', windows: 'Windows PC', other: 'Device',
};
const APP_WORDS: Record<DeviceApp, string> = {
  clem: 'Clem app', safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', browser: 'browser', unknown: '',
};

export function looksLikeUserAgent(label: string): boolean {
  return /^Mozilla\/\d/.test(label.trim());
}

export function describeDevice(label: string | undefined | null): DeviceName {
  const given = (label ?? '').trim();
  if (!given) return { name: 'Unnamed device', platform: 'other', app: 'unknown', derived: true };
  if (!looksLikeUserAgent(given)) return { name: given, platform: 'other', app: 'unknown', derived: false };
  const platform: DevicePlatform = /iPhone|iPod/.test(given) ? 'iphone'
    : /iPad/.test(given) ? 'ipad'
      : /Macintosh|Mac OS X/.test(given) ? 'mac'
        : /Android/.test(given) ? 'android'
          : /Windows/.test(given) ? 'windows'
            : 'other';
  const apple = platform === 'iphone' || platform === 'ipad';
  const app: DeviceApp = /CriOS|Chrome\//.test(given) ? 'chrome'
    : /FxiOS|Firefox\//.test(given) ? 'firefox'
      : /Safari\//.test(given) ? 'safari'
        // A WKWebView reports WebKit without the Safari product token: on an
        // Apple phone that is Clem's own shell.
        : apple ? 'clem'
          : 'browser';
  const appWord = APP_WORDS[app];
  return { name: appWord ? `${PLATFORM_WORDS[platform]} · ${appWord}` : PLATFORM_WORDS[platform], platform, app, derived: true };
}
