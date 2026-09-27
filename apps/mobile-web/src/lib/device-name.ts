/**
 * What this phone calls itself when it pairs: "iPhone · Clem app" or
 * "iPhone · Safari", never a raw user-agent string. The Mac keeps a chosen
 * label as written, so the name the owner sees later is decided here, once,
 * with the whole user-agent in hand.
 */
export function describeThisDevice(userAgent: string, nativeShell: boolean): string {
  const platform = /iPhone|iPod/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
      : /Macintosh|Mac OS X/.test(userAgent) ? 'Mac'
        : /Android/.test(userAgent) ? 'Android phone'
          : /Windows/.test(userAgent) ? 'Windows PC'
            : 'Device';
  const app = nativeShell ? 'Clem app'
    : /CriOS|Chrome\//.test(userAgent) ? 'Chrome'
      : /FxiOS|Firefox\//.test(userAgent) ? 'Firefox'
        : /Safari\//.test(userAgent) ? 'Safari'
          : /iPhone|iPad|iPod/.test(userAgent) ? 'Clem app'
            : 'browser';
  return `${platform} · ${app}`;
}
