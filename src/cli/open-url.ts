import { spawn } from 'node:child_process';

export function openBrowser(url: string): boolean {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
