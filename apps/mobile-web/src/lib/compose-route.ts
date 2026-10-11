/** Widget links select a foreground control; a URL never opens the microphone. */
export type ComposeMode = 'voice' | 'dictate';

export function composeModeFromSearch(search: string): ComposeMode | null {
  const params = new URLSearchParams(search);
  if (params.getAll('tab').length !== 1 || params.get('tab') !== 'chats' || params.getAll('compose').length !== 1) return null;
  const mode = params.get('compose');
  return mode === 'voice' || mode === 'dictate' ? mode : null;
}

export function consumeComposeSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('compose');
  return params.size ? `?${params}` : '';
}
