const $ = (sel, el = document) => el.querySelector(sel);

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

function wall(first, last) {
  if (!first || !last) return '—';
  const ms = new Date(last) - new Date(first);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function nativeName(source) {
  if (source === 'claude-code') return 'Claude Code';
  if (source === 'cowork') return 'Cowork';
  return 'Codex';
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
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

function spark(values, maxN = 40) {
  const slice = values.slice(-maxN);
  const max = Math.max(1, ...slice);
  return `<div class="spark" aria-hidden="true">${slice.map((v) =>
    `<i style="height:${Math.max(8, Math.round((v / max) * 100))}%"></i>`).join('')}</div>`;
}

function overhead(components) {
  const entries = Object.entries(components || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  return `<div class="overhead"><div style="color:var(--faint);margin-bottom:4px">Where Clementine spent prompt</div>${
    entries.slice(0, 6).map(([k, v]) =>
      `<div><span>${k}</span><b>${fmt(v)} · ${Math.round((v / total) * 100)}%</b></div>`
    ).join('')
  }</div>`;
}

function lane(title, totals, opts = {}) {
  const width = opts.peer ? Math.min(100, Math.round((totals.uncachedWork / Math.max(opts.peer, 1)) * 100)) : 100;
  return `
    <section class="lane ${opts.subject ? 'subject' : ''}">
      <h2>${title}${totals.models[0] ? ` · ${totals.models[0]}` : ''}</h2>
      <div class="hero num">${fmt(totals.uncachedWork)}<span class="hero-unit">uncached</span></div>
      ${opts.ratio != null ? `<div class="ratio num">${opts.ratio.toFixed(2)}× native</div>` : ''}
      <div class="bar" role="meter" aria-valuenow="${width}"><span style="width:${width}%"></span></div>
      <div class="stats">
        <div><b class="num">${totals.calls}</b>calls</div>
        <div><b class="num">${pct(totals.hitRate)}</b>cache hit</div>
        <div><b class="num">${wall(totals.firstAt, totals.lastAt)}</b>wall</div>
        <div><b class="num">${fmt(totals.promptTokens)}</b>prompt</div>
        <div><b class="num">${fmt(totals.cachedRead)}</b>cache read</div>
        <div><b class="num">${fmt(totals.cacheWrite)}</b>cache write</div>
      </div>
      ${spark(totals.sparkline || [])}
      ${totals.warmStart ? '<div class="warn">Warm start — first call already had a high cache hit. Not a cold comparison.</div>' : ''}
      ${opts.subject ? overhead(totals.promptComponents) : ''}
    </section>
  `;
}

function tape(native, clem) {
  const rows = [
    ...native.map((c) => ({ ...c, who: 'native' })),
    ...clem.map((c) => ({ ...c, who: 'clem' })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  if (!rows.length) return '';
  return `
    <section class="tape">
      <h2>Calls</h2>
      <table>
        <thead><tr><th>when</th><th>lane</th><th>model</th><th>uncached</th><th>prompt</th><th>cached</th><th>out</th></tr></thead>
        <tbody>
          ${rows.map((c) => `<tr>
            <td>${ago(c.at)}</td>
            <td>${c.who === 'clem' ? 'Clementine' : c.source}</td>
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

function bindCreate() {
  $('#create')?.addEventListener('submit', onCreate);
  $('select[name="pairing"]')?.addEventListener('change', (e) => {
    const pairing = e.target.value;
    $('#create').outerHTML = setupForm(pairing);
    bindCreate();
    const sel = $('select[name="pairing"]');
    if (sel) sel.value = pairing;
  });
}

function setupForm(pairing) {
  const claude = pairing === 'claude';
  return `
    <form class="form" id="create">
      <label>Task name
        <input name="name" required placeholder="10 untouched accounts, SEO, drafts" />
      </label>
      <div class="row">
        <label>Pairing
          <select name="pairing">
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label>Native app
          <select name="nativeSource">
            ${claude
              ? `<option value="claude-code">Claude Code</option><option value="cowork">Cowork / Claude Desktop Chat</option>`
              : `<option value="codex">Codex / ChatGPT desktop agent</option>`}
          </select>
        </label>
      </div>
      <label>Prompt (notes only — not sent)
        <textarea name="promptNote" placeholder="Paste the prompt you will run in both apps"></textarea>
      </label>
      <p class="note">Consumer ChatGPT chats are not measurable locally (encrypted / cloud). Codex work in the ChatGPT desktop app is the same ledger as Codex CLI.</p>
      <button class="btn primary" type="submit">Create trial</button>
    </form>
  `;
}

function render(state) {
  const root = $('#app');
  const trial = state?.trial;
  const created = Boolean(trial && trial.id);

  if (!created) {
    root.innerHTML = `
      <div class="app">
        <header class="top">
          <div>
            <div class="mark">Task meter</div>
            <h1 class="task-name">Same model, one task</h1>
            <p class="meta">Run it in the native app and in Clementine. Uncached work is the comparison.</p>
          </div>
        </header>
        ${setupForm('codex')}
      </div>`;
    bindCreate();
    return;
  }

  const live = Boolean(trial.armedAt) && !(trial.nativeSealedAt && trial.clementineSealedAt);
  const nativeTitle = nativeName(trial.nativeSource);
  const ratio = state.native.uncachedWork > 0 ? state.clementine.uncachedWork / state.native.uncachedWork : null;
  const waitingNative = trial.armedAt && !trial.nativeSessionId;
  const waitingClem = trial.armedAt && !trial.clementineSessionId;

  root.innerHTML = `
    <div class="app">
      <header class="top">
        <div>
          <div class="mark">${trial.pairing} pairing</div>
          <h1 class="task-name">${trial.name}</h1>
          <p class="meta">
            <span class="live-dot ${live ? '' : 'off'}"></span>
            ${live ? 'LIVE' : trial.nativeSealedAt && trial.clementineSealedAt ? 'sealed' : 'armed, waiting'}
            · ${nativeTitle} vs Clementine
            ${trial.nativeSessionId ? ` · native ${trial.nativeSessionId.slice(0, 8)}` : ''}
            ${trial.clementineSessionId ? ` · clem ${trial.clementineSessionId.slice(0, 10)}` : ''}
          </p>
        </div>
        <div class="row">
          ${trial.armedAt ? '' : '<button class="btn primary" id="arm">Arm</button>'}
          ${trial.armedAt && !(trial.nativeSealedAt && trial.clementineSealedAt)
            ? '<button class="btn" id="seal-native">Seal native</button><button class="btn" id="seal-clem">Seal Clementine</button><button class="btn primary" id="seal-both">Seal both</button>'
            : ''}
          <button class="btn" id="reset">New trial</button>
        </div>
      </header>
      ${state.verdict ? `<div class="verdict ${state.verdict.kind}">${state.verdict.sentence}</div>` : ''}
      ${!trial.armedAt ? `<p class="note">Arm, then run the same prompt in ${nativeTitle} and in Clementine on the ${trial.pairing} brain. New sessions after arm attach automatically.</p>` : ''}
      ${waitingNative ? `<p class="waiting">Waiting for a ${nativeTitle} session started after arm…</p>` : ''}
      ${waitingClem ? `<p class="waiting">Waiting for a Clementine ${trial.pairing} chat session started after arm…</p>` : ''}
      <div class="columns">
        ${lane(nativeTitle, state.native, { peer: Math.max(state.native.uncachedWork, state.clementine.uncachedWork) })}
        ${lane('Clementine', state.clementine, {
          subject: true,
          ratio,
          peer: Math.max(state.native.uncachedWork, state.clementine.uncachedWork),
        })}
      </div>
      ${candidates(state)}
      ${tape(state.nativeCalls || [], state.clementineCalls || [])}
    </div>
  `;

  $('#arm')?.addEventListener('click', () => api('/api/trial/arm').then(render));
  $('#seal-native')?.addEventListener('click', () => api('/api/trial/seal', { lane: 'native' }).then(render));
  $('#seal-clem')?.addEventListener('click', () => api('/api/trial/seal', { lane: 'clementine' }).then(render));
  $('#seal-both')?.addEventListener('click', () => api('/api/trial/seal', { lane: 'both' }).then(render));
  $('#reset')?.addEventListener('click', () => api('/api/trial/reset').then(render));
  for (const btn of document.querySelectorAll('[data-bind]')) {
    btn.addEventListener('click', () => api('/api/trial/bind', {
      lane: btn.dataset.lane,
      sessionId: btn.dataset.bind,
    }).then(render));
  }
}

function candidates(state) {
  const list = state.candidates || [];
  if (!list.length || !state.trial?.armedAt) return '';
  return `<div class="cands">${list.map((c) => `
    <button class="cand" data-bind="${c.id}" data-lane="${c.source === 'clementine' ? 'clementine' : 'native'}">
      <span><b>${c.source}</b> ${c.title || c.id.slice(0, 12)} ${c.model ? `· ${c.model}` : ''}</span>
      <span class="meta">${ago(c.startedAt)}</span>
    </button>`).join('')}</div>`;
}

async function onCreate(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const snap = await api('/api/trial', {
    name: fd.get('name'),
    pairing: fd.get('pairing'),
    nativeSource: fd.get('nativeSource'),
    promptNote: fd.get('promptNote'),
  });
  render(snap);
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    try {
      const snap = JSON.parse(e.data);
      if (!snap.trial?.id && $('#create')) return;
      render(snap);
    } catch { /* ignore */ }
  });
  es.onerror = () => { /* browser reconnects */ };
}

api('/api/trial').then((snap) => {
  render(snap);
  connect();
}).catch(() => {
  render(null);
  connect();
});
