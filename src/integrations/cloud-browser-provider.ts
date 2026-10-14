/**
 * The cloud browser providers Clem can drive, and the owner's choice among
 * them (or this computer's own Chrome). One browser is used at a time: the
 * one chosen on the Connect screen; the side-by-side window, the tools and
 * every workflow step follow that choice.
 */
export type CloudBrowserProvider = 'browserbase' | 'kernel';
export type BrowserChoice = CloudBrowserProvider | 'local';

export const CLOUD_BROWSER_PROVIDERS: readonly CloudBrowserProvider[] = ['browserbase', 'kernel'];
export const BROWSER_CHOICES: readonly BrowserChoice[] = ['browserbase', 'kernel', 'local'];

export function isCloudBrowserProvider(value: unknown): value is CloudBrowserProvider {
  return value === 'browserbase' || value === 'kernel';
}

export function isBrowserChoice(value: unknown): value is BrowserChoice {
  return isCloudBrowserProvider(value) || value === 'local';
}

export interface CloudBrowserProviderInfo {
  readonly provider: CloudBrowserProvider;
  /** What the owner sees. */
  readonly label: string;
  /** The secret that holds the provider's API key. */
  readonly secretName: string;
  /** Where the key is made. */
  readonly keyUrl: string;
  /** Whether a project id is part of the connection (Browserbase: required;
   *  Kernel: optional, the key's organization default otherwise). */
  readonly projectId: 'required' | 'optional';
  /** Live view origins the chat's page may frame and connect to. */
  readonly liveViewFrameOrigins: readonly string[];
  readonly liveViewConnectOrigins: readonly string[];
}

export const CLOUD_BROWSER_PROVIDER_INFO: Record<CloudBrowserProvider, CloudBrowserProviderInfo> = {
  browserbase: {
    provider: 'browserbase',
    label: 'Browserbase',
    secretName: 'browserbase_api_key',
    keyUrl: 'https://www.browserbase.com/settings',
    projectId: 'required',
    liveViewFrameOrigins: ['https://www.browserbase.com', 'https://browserbase.com'],
    liveViewConnectOrigins: [],
  },
  kernel: {
    provider: 'kernel',
    label: 'Kernel',
    secretName: 'kernel_api_key',
    keyUrl: 'https://dashboard.onkernel.com',
    projectId: 'optional',
    liveViewFrameOrigins: ['https://*.onkernel.com:8443', 'https://*.kernel.sh:8443'],
    liveViewConnectOrigins: ['https://*.onkernel.com:8443', 'wss://*.onkernel.com:8443', 'https://*.kernel.sh:8443', 'wss://*.kernel.sh:8443'],
  },
};

/** Every provider's live view origins, for the page's content security policy. */
export function cloudBrowserLiveViewFrameOrigins(): string[] {
  return CLOUD_BROWSER_PROVIDERS.flatMap((provider) => CLOUD_BROWSER_PROVIDER_INFO[provider].liveViewFrameOrigins);
}

export function cloudBrowserLiveViewConnectOrigins(): string[] {
  return CLOUD_BROWSER_PROVIDERS.flatMap((provider) => CLOUD_BROWSER_PROVIDER_INFO[provider].liveViewConnectOrigins);
}
