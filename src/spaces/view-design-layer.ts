/**
 * The framework-owned design layer every served Workspace view carries.
 *
 * A view is authored by the model inside a small byte budget. Without this
 * layer each view starts from a blank page: no palette, no light/dark, no
 * font, no formatting, and every table and empty state hand-rolled. With it,
 * the bytes go to the reading order and the data, and every Workspace looks
 * like it belongs to the same product in both themes.
 *
 * Two pieces, both inline (the view CSP allows inline style/script only):
 *  - `CLEM_VIEW_DESIGN_STYLE` — the shared semantic tokens (the same values
 *    the desktop shell reads from packages/design-tokens), the surface ramp,
 *    a zero-specificity base so any authored rule still wins, and a compact
 *    component vocabulary (`.clem-*`). Dark follows the desktop's theme
 *    through `data-theme` on <html>, else the system preference.
 *  - `CLEM_VIEW_KIT` — pure helpers (`fmt`, `ui`, `sources`, `theme`) merged
 *    into the frozen `window.clem` by the bridge. They return strings and
 *    never touch the network or the DOM, so the containment story of the
 *    bridge is unchanged.
 */

export const CLEM_VIEW_DESIGN_STYLE_ID = 'clem-view-design';

const TOKENS_LIGHT = `
  color-scheme: light;
  --clem-primary:#f26419;--clem-primary-hover:#ff8442;--clem-primary-press:#de5a12;--clem-primary-tint:#fff4ed;
  --clem-primary-ink:#b94300;--clem-primary-ink-hover:#963400;--clem-primary-fg:#1f1b16;
  --clem-ink:#1f1b16;--clem-ink-muted:#5c564b;--clem-ink-subtle:#75644f;
  --clem-success:#2e7d46;--clem-success-tint:#e8f5ec;--clem-info:#1e6fb8;--clem-info-tint:#e6f1fa;
  --clem-warning:#8a6000;--clem-warning-tint:#fcf1de;--clem-danger:#c0392b;--clem-danger-tint:#fbe9e7;
  --clem-danger-hover:#a5301f;--clem-danger-press:#8f2417;--clem-danger-fg:#ffffff;
  --clem-bg-canvas:#faf7f2;--clem-bg-surface:#ffffff;--clem-bg-subtle:#f4f0e9;--clem-bg-hover:#efeae1;--clem-bg-raised:#ffffff;
  --clem-border:#e7e1d6;--clem-border-strong:#d6cfc0;
  --clem-focus:var(--clem-primary-ink);--clem-focus-width:2px;--clem-focus-offset:2px;
  --clem-ease:cubic-bezier(0.22,1,0.36,1);--clem-dur-fast:120ms;--clem-dur-base:180ms;--clem-dur-slow:300ms;--clem-press:0.97;
  --clem-radius:10px;--clem-radius-sm:6px;--clem-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  --clem-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
`;

const TOKENS_DARK = `
  color-scheme: dark;
  --clem-primary:#ff7a45;--clem-primary-hover:#ff9466;--clem-primary-press:#f26419;--clem-primary-tint:#2e2017;
  --clem-primary-ink:#ff7a45;--clem-primary-ink-hover:#ff9466;--clem-primary-fg:#1f1b16;
  --clem-ink:#f5f1e8;--clem-ink-muted:#b8b1a1;--clem-ink-subtle:#9a9282;
  --clem-success:#5bc97e;--clem-success-tint:#1c2e22;--clem-info:#5ba8e0;--clem-info-tint:#172633;
  --clem-warning:#e0a030;--clem-warning-tint:#33270f;--clem-danger:#f0685a;--clem-danger-tint:#3a1d19;
  --clem-danger-hover:#ff8a7a;--clem-danger-press:#e5604f;--clem-danger-fg:#1f1b16;
  --clem-bg-canvas:#16140f;--clem-bg-surface:#1f1c16;--clem-bg-subtle:#2a271f;--clem-bg-hover:#332f26;--clem-bg-raised:#262219;
  --clem-border:#3a352b;--clem-border-strong:#4e4839;
`;

const COMPONENTS = `
:where(html){font-family:var(--clem-font);font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased;text-size-adjust:100%}
:where(body){margin:0;background:var(--clem-bg-canvas);color:var(--clem-ink)}
:where(h1,h2,h3,h4){margin:0;font-weight:650;letter-spacing:-.01em;line-height:1.2}
:where(h1){font-size:1.5rem}:where(h2){font-size:1.1rem}:where(h3){font-size:.95rem}
:where(p){margin:0}:where(a){color:var(--clem-primary-ink)}:where(a:hover){color:var(--clem-primary-ink-hover)}
:where(button){font:inherit}
:where(:focus-visible){outline:var(--clem-focus-width) solid var(--clem-focus);outline-offset:var(--clem-focus-offset)}
.clem-app{width:100%;margin:0;padding:20px 24px 48px;box-sizing:border-box}
.clem-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.clem-header .clem-sub{color:var(--clem-ink-muted);font-size:.9rem;margin-top:4px}
.clem-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.clem-stack{display:flex;flex-direction:column;gap:8px}
.clem-muted{color:var(--clem-ink-muted)}.clem-subtle{color:var(--clem-ink-subtle)}.clem-num{font-variant-numeric:tabular-nums}
.clem-small{font-size:.85rem}.clem-mono{font-family:var(--clem-mono);font-size:.85em}
.clem-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.clem-kpi{background:var(--clem-bg-surface);border:1px solid var(--clem-border);border-radius:var(--clem-radius);padding:14px 16px;min-width:0}
.clem-kpi-label{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--clem-ink-subtle);font-weight:600}
.clem-kpi-value{font-size:1.7rem;font-weight:700;line-height:1.15;margin-top:4px;font-variant-numeric:tabular-nums}
.clem-kpi-hint{font-size:.82rem;color:var(--clem-ink-muted);margin-top:4px}
.clem-kpi-ok .clem-kpi-value{color:var(--clem-success)}.clem-kpi-warn .clem-kpi-value{color:var(--clem-warning)}
.clem-kpi-danger .clem-kpi-value{color:var(--clem-danger)}.clem-kpi-info .clem-kpi-value{color:var(--clem-info)}
.clem-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start}
.clem-card{background:var(--clem-bg-surface);border:1px solid var(--clem-border);border-radius:var(--clem-radius);padding:16px;min-width:0}
.clem-card-raised{background:var(--clem-bg-raised);border-color:var(--clem-border-strong)}
.clem-section{background:var(--clem-bg-surface);border:1px solid var(--clem-border);border-radius:var(--clem-radius);min-width:0;overflow:hidden}
.clem-section-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--clem-border);background:var(--clem-bg-subtle)}
.clem-section-head h2{flex:1 1 auto;font-size:.95rem}
.clem-section-count{font-size:.8rem;font-weight:600;color:var(--clem-ink-muted);background:var(--clem-bg-surface);border:1px solid var(--clem-border);border-radius:999px;padding:1px 8px;font-variant-numeric:tabular-nums}
.clem-section-meta{font-size:.8rem;color:var(--clem-ink-subtle)}
.clem-section-body{padding:4px 0}
.clem-list{list-style:none;margin:0;padding:0}
.clem-item{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:10px 16px;border-top:1px solid var(--clem-border);align-items:start}
.clem-list>.clem-item:first-child{border-top:0}
.clem-item-title{font-weight:600;min-width:0;overflow-wrap:anywhere}
.clem-item-meta{grid-column:2;grid-row:1;font-size:.8rem;color:var(--clem-ink-subtle);white-space:nowrap;font-variant-numeric:tabular-nums}
.clem-item-body{grid-column:1/-1;font-size:.9rem;color:var(--clem-ink-muted);overflow-wrap:anywhere}
.clem-item-tags{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.clem-item-urgent{box-shadow:inset 3px 0 0 var(--clem-danger)}.clem-item-warn{box-shadow:inset 3px 0 0 var(--clem-warning)}
.clem-item:hover{background:var(--clem-bg-hover)}
.clem-table-wrap{overflow-x:auto}
.clem-table{width:100%;border-collapse:collapse;font-size:.9rem}
.clem-table th{text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--clem-ink-subtle);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--clem-border);background:var(--clem-bg-subtle);white-space:nowrap}
.clem-table td{padding:9px 12px;border-bottom:1px solid var(--clem-border);vertical-align:top;overflow-wrap:anywhere}
.clem-table tr:last-child td{border-bottom:0}.clem-table tbody tr:hover{background:var(--clem-bg-hover)}
.clem-table .clem-right,.clem-table th.clem-right{text-align:right;font-variant-numeric:tabular-nums}
.clem-tag{display:inline-flex;align-items:center;gap:4px;font-size:.75rem;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--clem-bg-subtle);color:var(--clem-ink-muted);border:1px solid var(--clem-border);white-space:nowrap;line-height:1.4}
.clem-tag-ok{background:var(--clem-success-tint);color:var(--clem-success);border-color:transparent}
.clem-tag-warn{background:var(--clem-warning-tint);color:var(--clem-warning);border-color:transparent}
.clem-tag-danger{background:var(--clem-danger-tint);color:var(--clem-danger);border-color:transparent}
.clem-tag-info{background:var(--clem-info-tint);color:var(--clem-info);border-color:transparent}
.clem-tag-primary{background:var(--clem-primary-tint);color:var(--clem-primary-ink);border-color:transparent}
.clem-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:.85rem;font-weight:600;padding:6px 12px;border-radius:var(--clem-radius-sm);border:1px solid var(--clem-border-strong);background:var(--clem-bg-surface);color:var(--clem-ink);cursor:pointer;transition:background var(--clem-dur-fast) var(--clem-ease),transform var(--clem-dur-fast) var(--clem-ease);white-space:nowrap}
.clem-btn:hover{background:var(--clem-bg-hover)}.clem-btn:active{transform:scale(var(--clem-press))}
.clem-btn[disabled]{opacity:.55;cursor:default;transform:none}
.clem-btn-primary{background:var(--clem-primary);border-color:transparent;color:var(--clem-primary-fg)}.clem-btn-primary:hover{background:var(--clem-primary-hover)}.clem-btn-primary:active{background:var(--clem-primary-press)}
.clem-btn-ghost{background:transparent;border-color:transparent;color:var(--clem-primary-ink)}.clem-btn-ghost:hover{background:var(--clem-primary-tint)}
.clem-btn-danger{background:var(--clem-danger);border-color:transparent;color:var(--clem-danger-fg)}.clem-btn-danger:hover{background:var(--clem-danger-hover)}
.clem-btn-sm{font-size:.78rem;padding:3px 9px}
.clem-empty{padding:22px 16px;text-align:center;color:var(--clem-ink-muted);font-size:.9rem}
.clem-empty-hint{display:block;margin-top:4px;font-size:.82rem;color:var(--clem-ink-subtle)}
.clem-pending{display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:var(--clem-radius-sm);background:var(--clem-warning-tint);color:var(--clem-warning);font-size:.88rem;font-weight:600}
.clem-error{padding:10px 14px;border-radius:var(--clem-radius-sm);background:var(--clem-danger-tint);color:var(--clem-danger);font-size:.88rem}
.clem-src{display:flex;gap:12px;flex-wrap:wrap;font-size:.8rem;color:var(--clem-ink-subtle)}
.clem-src-item{display:inline-flex;align-items:center;gap:6px}
.clem-dot{width:8px;height:8px;border-radius:50%;background:var(--clem-ink-subtle);flex:none}
.clem-dot-ok{background:var(--clem-success)}.clem-dot-warn{background:var(--clem-warning)}.clem-dot-danger{background:var(--clem-danger)}
.clem-skeleton{background:linear-gradient(90deg,var(--clem-bg-subtle),var(--clem-bg-hover),var(--clem-bg-subtle));background-size:200% 100%;animation:clem-shimmer 1.2s linear infinite;border-radius:var(--clem-radius-sm);min-height:1em}
@keyframes clem-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.clem-progress{height:6px;border-radius:999px;background:var(--clem-bg-subtle);overflow:hidden}.clem-progress>i{display:block;height:100%;background:var(--clem-primary)}
@media (max-width:720px){.clem-app{padding:14px 14px 40px}.clem-grid{grid-template-columns:1fr}.clem-item{grid-template-columns:1fr}.clem-item-meta{grid-column:1;grid-row:auto;white-space:normal}.clem-kpi-value{font-size:1.4rem}}
@media (prefers-reduced-motion:reduce){.clem-skeleton{animation:none}.clem-btn{transition:none}}
`;

export const CLEM_VIEW_DESIGN_STYLE = `<style id="${CLEM_VIEW_DESIGN_STYLE_ID}">`
  + `:root{${TOKENS_LIGHT.replace(/\n\s*/g, '')}}`
  + `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${TOKENS_DARK.replace(/\n\s*/g, '')}}}`
  + `:root[data-theme=dark]{${TOKENS_DARK.replace(/\n\s*/g, '')}}`
  + COMPONENTS.replace(/\n/g, '')
  + '</style>';

/**
 * Pure helpers. Runs before the bridge, which merges `window.__clemKit` into
 * the frozen `window.clem` and removes the staging global. Every `ui.*`
 * helper returns an HTML string with every interpolated field escaped, so a
 * view that renders external text through them cannot be scripted by it.
 * Theme: honours `?theme=dark|light` handed in by the desktop shell (set as
 * `data-theme` on <html> before any style resolves), else the system.
 */
export const CLEM_VIEW_KIT_JS = `(function(){'use strict';
var ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return ESC[c];});}
function num(v){var n=typeof v==='number'?v:parseFloat(v);return isFinite(n)?n:null;}
function when(v){if(v==null||v==='')return null;var d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function pad(n){return (n<10?'0':'')+n;}
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var fmt={
esc:esc,
number:function(v,d){var n=num(v);if(n===null)return '\\u2014';try{return n.toLocaleString(undefined,{maximumFractionDigits:d==null?0:d});}catch(_){return String(Math.round(n));}},
money:function(v,currency){var n=num(v);if(n===null)return '\\u2014';var cur=currency||'USD';try{return new Intl.NumberFormat(undefined,{style:'currency',currency:cur,notation:Math.abs(n)>=1e4?'compact':'standard',maximumFractionDigits:Math.abs(n)>=1e4?1:0}).format(n).replace(/\.0([KMB])$/,'$1');}catch(_){var a=Math.abs(n),s=n<0?'-':'';if(a>=1e9)return s+'$'+(a/1e9).toFixed(1)+'B';if(a>=1e6)return s+'$'+(a/1e6).toFixed(1)+'M';if(a>=1e4)return s+'$'+Math.round(a/1e3)+'K';return s+'$'+fmt.number(a,0);}},
percent:function(v,d){var n=num(v);if(n===null)return '\\u2014';return fmt.number(n,d==null?0:d)+'%';},
date:function(v,style){var d=when(v);if(!d)return '\\u2014';var s=MONTHS[d.getMonth()]+' '+d.getDate();if(style==='long')s=DAYS[d.getDay()]+', '+s;if(style==='year'||d.getFullYear()!==new Date().getFullYear())s+=', '+d.getFullYear();return s;},
time:function(v){var d=when(v);if(!d)return '\\u2014';var h=d.getHours(),m=d.getMinutes(),ap=h>=12?'PM':'AM';h=h%12||12;return h+':'+pad(m)+' '+ap;},
relative:function(v,now){var d=when(v);if(!d)return '\\u2014';var t=(now?when(now):new Date())||new Date();var s=Math.round((d.getTime()-t.getTime())/1000),a=Math.abs(s),f=s<0;function u(n,l){return f?n+l+' ago':'in '+n+l;}if(a<45)return 'just now';if(a<3600)return u(Math.round(a/60),'m');if(a<86400)return u(Math.round(a/3600),'h');if(a<86400*14)return u(Math.round(a/86400),'d');return fmt.date(d);},
daysUntil:function(v,now){var d=when(v);if(!d)return null;var t=(now?when(now):new Date())||new Date();var a=new Date(d.getFullYear(),d.getMonth(),d.getDate()),b=new Date(t.getFullYear(),t.getMonth(),t.getDate());return Math.round((a-b)/86400000);},
plural:function(n,one,many){var c=num(n);if(c===null)c=0;return fmt.number(c,0)+' '+(c===1?one:(many||one+'s'));},
truncate:function(s,n){s=String(s==null?'':s);n=n||80;return s.length>n?s.slice(0,n-1).replace(/\\s+\\S*$/,'')+'\\u2026':s;},
initials:function(name){return String(name||'').split(/\\s+/).filter(Boolean).slice(0,2).map(function(p){return p[0].toUpperCase();}).join('');}
};
function attrs(o){var out='';if(!o)return out;for(var k in o){if(o[k]==null||o[k]===false)continue;out+=' '+k+'="'+esc(o[k]===true?k:o[k])+'"';}return out;}
function toneClass(prefix,tone){return tone?' '+prefix+'-'+esc(tone):'';}
var ui={
tag:function(text,tone){return '<span class="clem-tag'+toneClass('clem-tag',tone)+'">'+esc(text)+'</span>';},
kpis:function(items){var h='<div class="clem-kpis">';(items||[]).forEach(function(k){h+='<div class="clem-kpi'+toneClass('clem-kpi',k.tone)+'"><div class="clem-kpi-label">'+esc(k.label)+'</div><div class="clem-kpi-value">'+esc(k.value)+'</div>'+(k.hint?'<div class="clem-kpi-hint">'+esc(k.hint)+'</div>':'')+'</div>';});return h+'</div>';},
empty:function(text,hint){return '<div class="clem-empty">'+esc(text||'Nothing here right now')+(hint?'<span class="clem-empty-hint">'+esc(hint)+'</span>':'')+'</div>';},
pending:function(text){return '<div class="clem-pending" role="status">\\u23f3 '+esc(text||'Waiting for your approval in the inbox')+'</div>';},
error:function(text){return '<div class="clem-error" role="alert">'+esc(text)+'</div>';},
card:function(body,opts){opts=opts||{};return '<div class="clem-card'+(opts.raised?' clem-card-raised':'')+'"'+attrs(opts.attrs)+'>'+(opts.title?'<h3>'+esc(opts.title)+'</h3>':'')+(body||'')+'</div>';},
section:function(title,body,opts){opts=opts||{};return '<section class="clem-section"'+attrs(opts.attrs)+'><div class="clem-section-head"><h2>'+esc(title)+'</h2>'+(opts.count!=null?'<span class="clem-section-count">'+esc(opts.count)+'</span>':'')+(opts.meta?'<span class="clem-section-meta">'+esc(opts.meta)+'</span>':'')+(opts.actions||'')+'</div><div class="clem-section-body">'+(body||'')+'</div></section>';},
list:function(items,opts){opts=opts||{};if(!items||!items.length)return ui.empty(opts.empty,opts.emptyHint);var h='<ul class="clem-list">';items.forEach(function(it){var cls='clem-item'+(it.urgent?' clem-item-urgent':it.warn?' clem-item-warn':'');var title=it.href?'<a href="'+esc(it.href)+'">'+esc(it.title)+'</a>':esc(it.title);h+='<li class="'+cls+'"'+attrs(it.attrs)+'><div class="clem-item-title">'+title+'</div>'+(it.meta?'<div class="clem-item-meta">'+esc(it.meta)+'</div>':'')+(it.body?'<div class="clem-item-body">'+esc(it.body)+'</div>':'')+(it.html?'<div class="clem-item-body">'+it.html+'</div>':'')+(it.tags&&it.tags.length?'<div class="clem-item-tags">'+it.tags.map(function(t){return typeof t==='string'?ui.tag(t):ui.tag(t.text,t.tone);}).join('')+'</div>':'')+'</li>';});return h+'</ul>';},
table:function(rows,cols,opts){opts=opts||{};if(!rows||!rows.length)return ui.empty(opts.empty,opts.emptyHint);var h='<div class="clem-table-wrap"><table class="clem-table"><thead><tr>';cols.forEach(function(c){h+='<th'+(c.align==='right'?' class="clem-right"':'')+(c.width?' style="width:'+esc(c.width)+'"':'')+'>'+esc(c.label==null?c.key:c.label)+'</th>';});h+='</tr></thead><tbody>';rows.forEach(function(r,i){h+='<tr'+attrs(opts.rowAttrs?opts.rowAttrs(r,i):null)+'>';cols.forEach(function(c){var v=c.render?c.render(r,i):(c.key?r[c.key]:'');h+='<td'+(c.align==='right'?' class="clem-right"':'')+'>'+(c.html?String(v==null?'':v):esc(v))+'</td>';});h+='</tr>';});return h+'</tbody></table></div>';},
sourceStrip:function(){var s=sources();if(!s.length)return '';return '<div class="clem-src">'+s.map(function(x){return '<span class="clem-src-item"><i class="clem-dot '+(x.ok===false?'clem-dot-danger':x.stale?'clem-dot-warn':x.ok?'clem-dot-ok':'')+'"></i>'+esc(x.id)+(x.refreshedAt?' \\u00b7 '+esc(fmt.relative(x.refreshedAt)):'')+(x.ok===false&&x.error?' \\u00b7 '+esc(fmt.truncate(x.error,60)):'')+'</span>';}).join('')+'</div>';}
};
function sources(){var d=window.__SPACE_DATA__,meta=d&&d._meta,out=[];if(!meta||typeof meta!=='object')return out;for(var id in meta){var m=meta[id]||{};if(id.charAt(0)==='_')continue;var at=when(m.refreshedAt),age=at?(Date.now()-at.getTime())/3600000:null;out.push({id:id,ok:m.ok!==false,error:m.error||m.lastError||null,refreshedAt:at?at.toISOString():null,ageHours:age,stale:age!==null&&age>36,provenance:m.provenance||null});}return out;}
function theme(){var t=null;try{t=document.documentElement.getAttribute('data-theme');}catch(_){}if(t!=='dark'&&t!=='light'){try{t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch(_){t='light';}}return {name:t,isDark:t==='dark'};}
try{var q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light')document.documentElement.setAttribute('data-theme',q);}catch(_){}
window.__clemKit={fmt:Object.freeze(fmt),ui:Object.freeze(ui),sources:sources,theme:theme};
})();`;

export const CLEM_VIEW_KIT = `<script>${CLEM_VIEW_KIT_JS}</script>`;

/**
 * The bridge merges the kit into `window.clem` with this snippet (inline JS
 * that runs inside the bridge closure): kit first so the RPC surface wins on
 * any name clash, then the staging global is deleted.
 */
export const CLEM_VIEW_KIT_MERGE_JS =
  'var K=window.__clemKit||{};try{delete window.__clemKit;}catch(_){}';

/** The framework layer served ahead of every view: kit, then style. */
export function clemViewDesignLayer(): string {
  return CLEM_VIEW_KIT + CLEM_VIEW_DESIGN_STYLE;
}
