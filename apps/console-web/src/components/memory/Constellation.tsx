/**
 * What the selected memory connects to, as a small night-sky graph: the memory
 * at the center, first-degree neighbors on a ring, second-degree beyond,
 * relation labels on the edges. Reads the neighborhood endpoint; draws once.
 */
import { useEffect, useState } from 'react';
import { getGraphNeighborhood } from '@/lib/memory';
import { layoutConstellation, type Constellation as Stars } from '@/lib/constellation';

const NODE_COLOR: Record<string, string> = { fact: '#FFB27A', entity: '#7FB0E0', file: '#9B96AE', resource: '#9B96AE', episode: '#9B96AE', policy: '#D9A93B', procedure: '#8B7CF6' };

export function Constellation({ seedId, onPick }: { seedId: string; onPick?: (nodeId: string) => void }) {
  const [stars, setStars] = useState<Stars | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setStars(null); setFailed(false);
    getGraphNeighborhood(seedId, 2)
      .then((g) => { if (alive) setStars(layoutConstellation(seedId, g.nodes, g.edges)); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [seedId]);
  if (failed || (stars && stars.nodes.length <= 1)) {
    return <div className="mb-4 rounded-md border px-3 py-6 text-center text-caption" style={{ borderColor: '#2B2937', color: '#9B96AE', background: '#1D1B26' }}>{failed ? 'Connections unavailable right now.' : 'Not connected to anything else yet.'}</div>;
  }
  return (
    <div className="mb-4 overflow-hidden rounded-md border" style={{ borderColor: '#2B2937', background: '#1D1B26' }} aria-label="What this connects to">
      <svg viewBox="0 0 356 170" className="block h-[170px] w-full">
        <defs><radialGradient id="star-glow" cx="50%" cy="50%"><stop offset="0%" stopColor="#8B7CF6" stopOpacity=".8" /><stop offset="100%" stopColor="#8B7CF6" stopOpacity="0" /></radialGradient></defs>
        {stars && (
          <>
            {stars.edges.map((e) => (
              <g key={e.id}>
                <line x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y} stroke="#3A3750" strokeWidth={e.weak ? 1 : 1.75} strokeDasharray={e.weak ? '3 3' : undefined} />
                {!e.weak && <text x={(e.from.x + e.to.x) / 2} y={(e.from.y + e.to.y) / 2 - 4} textAnchor="middle" fontSize="9.5" fontFamily="JetBrains Mono, ui-monospace, monospace" fill="#9B96AE">{e.label}</text>}
              </g>
            ))}
            <circle cx={stars.nodes[0].x} cy={stars.nodes[0].y} r="26" fill="url(#star-glow)" />
            {stars.nodes.map((n) => (
              <g key={n.id} onClick={() => n.ring !== 0 && onPick?.(n.id)} style={{ cursor: n.ring !== 0 && onPick ? 'pointer' : 'default' }}>
                <circle cx={n.x} cy={n.y} r={n.ring === 0 ? 7 : n.ring === 1 ? 5 : 3.5} fill={NODE_COLOR[n.type] ?? '#9B96AE'} />
                <text x={n.x} y={n.y + (n.ring === 0 ? 20 : n.ring === 1 ? -10 : 14)} textAnchor="middle" fontSize="11" fontFamily="Manrope, system-ui, sans-serif" fill="#EDE9F6">{n.label}</text>
              </g>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}
