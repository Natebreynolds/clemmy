import { useLayoutEffect, useState } from 'preact/hooks';

/** One captured submission, owned by one mounted editor/screen identity. */
export class PendingCommit {
  private active: symbol | null = null;

  constructor(private scope: string) {}

  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.invalidate();
    this.scope = scope;
  }

  get pending(): boolean { return this.active !== null; }

  begin(): symbol | null {
    if (this.pending) return null;
    this.active = Symbol(this.scope);
    return this.active;
  }

  owns(token: symbol): boolean { return this.active === token; }

  finish(token: symbol): boolean {
    if (!this.owns(token)) return false;
    this.active = null;
    return true;
  }

  invalidate(): void { this.active = null; }
}

export function usePendingCommit(scope: string): PendingCommit {
  const [commit] = useState(() => new PendingCommit(scope));
  useLayoutEffect(() => {
    commit.setScope(scope);
    return () => commit.invalidate();
  }, [commit, scope]);
  return commit;
}
