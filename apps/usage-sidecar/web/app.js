const $ = (sel, el = document) => el.querySelector(sel);

const LABELS = {
  clementine: 'Clementine',
  'claude-code': 'Claude Code',
  cowork: 'Cowork',
  codex: 'Codex',
};

function fmt(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 1 : 2)}k`;
  return String(Math.round(n));
}

function pct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function sinceLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function spark(values) {
  const slice = (values || []).slice(-40);
  if (!slice.length) return '';
  const max = Math.max(1, ...slice);
  return `<div class="spark" aria-hidden="true">${slice.map((v) =>
    `<i style="height:${Math.max(8, Math.round((v / max) * 100))}%"></i>`).join('')}</div>`;
}

function sourceCard(id, totals) {
  const live = (totals.lastAt && Date.now() - Date.parse(totals.lastAt) < 90_000);
  return `
    <section class="lane ${id === 'clementine' ? 'subject' : ''} ${live ? 'emitting' : ''}">
      <h2>${LABELS[id] || id}${live ? ' · emitting' : ''}</h2>
      <div class="hero num">${fmt(totals.uncachedWork)}<span class="hero-unit">uncached</span></div>
      <div class="stats">
        <div><b class="num">${totals.calls}</b>calls</div>
        <div><b class="num">${pct(totals.hitRate)}</b>cache hit</div>
        <div><b class="num">${fmt(totals.outputTokens)}</b>out</div>
      </div>
      ${spark(totals.sparkline)}
    </section>
  `;
}

function taskRow(t) {
  const short = t.id.length > 18 ? `${t.id.slice(0, 16)}…` : t.id;
  const bits = [LABELS[t.source] || t.source, t.brain, t.kind, t.model].filter(Boolean);
  return `
    <li class="task ${t.live ? 'live' : ''}">
      <span class="live-dot ${t.live ? '' : 'off'}"></span>
      <div>
        <div><b>${bits[0]}</b> · ${short}</div>
        <div class="meta">${bits.slice(1).join(' · ') || '—'}</div>
      </div>
      <div class="task-nums">
        <b class="num">${fmt(t.totals.uncachedWork)}</b>
        <span class="meta">${t.totals.calls} · ${ago(t.lastAt)}</span>
      </div>
    </li>
  `;
}

function tape(calls) {
  if (!calls?.length) {
    return `<section class="tape"><h2>Calls</h2><p class="waiting">Waiting for a task to emit tokens…</p></section>`;
  }
  return `
    <section class="tape">
      <h2>Calls</h2>
      <table>
        <thead><tr><th>when</th><th>source</th><th>task</th><th>model</th><th>uncached</th><th>prompt</th><th>cached</th><th>out</th></tr></thead>
        <tbody>
          ${calls.map((c) => `<tr>
            <td>${ago(c.at)}</td>
            <td>${LABELS[c.source] || c.source}${c.kind ? ` · ${c.kind}` : ''}</td>
            <td class="num">${(c.rootSessionId || c.sessionId).slice(0, 12)}</td>
            <td>${c.model || '—'}</td>
            <td class="num">${fmt(c.uncachedWorkTokens)}</td>
            <td class="num">${fmt(c.promptTokens)}</td>
            <td class="num">${fmt(c.cachedReadTokens)}</td>
            <td class="num">${fmt(c.outputTokens)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function render(state) {
  const root = $('#app');
  if (!state) return;
  const sources = state.sources || {};
  const emitting = (state.tasks || []).some((t) => t.live);
  root.innerHTML = `
    <div class="app">
      <header class="top">
        <div>
          <div class="mark">Token meter</div>
          <h1 class="task-name">Live</h1>
          <p class="meta">
            <span class="live-dot ${emitting ? '' : 'off'}"></span>
            ${emitting ? 'emitting' : 'watching'}
            · since ${sinceLabel(state.watchingSince)}
          </p>
        </div>
        <div class="row">
          <button class="btn" id="clear">Clear</button>
        </div>
      </header>
      <div class="columns four">
        ${sourceCard('clementine', sources.clementine || {})}
        ${sourceCard('claude-code', sources['claude-code'] || {})}
        ${sourceCard('cowork', sources.cowork || {})}
        ${sourceCard('codex', sources.codex || {})}
      </div>
      <section class="tasks">
        <h2>Tasks</h2>
        ${(state.tasks || []).length
          ? `<ul>${state.tasks.map(taskRow).join('')}</ul>`
          : `<p class="waiting">Open Clementine, Claude Code, Cowork, or Codex and run a task. Totals start from when this window opened.</p>`}
      </section>
      ${tape(state.recentCalls || [])}
    </div>
  `;
  $('#clear')?.addEventListener('click', () => api('/api/clear').then(render));
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    try { render(JSON.parse(e.data)); } catch { /* ignore */ }
  });
}

api('/api/live').then((snap) => {
  render(snap);
  connect();
}).catch(() => connect());
