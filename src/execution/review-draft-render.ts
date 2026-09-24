/**
 * A reviewer reads a draft, not a data structure. The material a review gate
 * shows is whatever the gated step consumes — often JSON from a drafting
 * step. Render it as a person would write it down: numbered items, one
 * "Label: value" line per field, long text on its own lines. No field names
 * are assumed; labels come from the keys the author chose.
 */

const MAX_DEPTH = 4;

function labelOf(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function scalarText(value: string | number | boolean | null): string {
  if (value === null) return '—';
  return typeof value === 'string' ? value.trim() : String(value);
}

function renderObject(value: Record<string, unknown>, indent: string, depth: number): string[] {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const label = labelOf(key);
    if (isScalar(child)) {
      const text = scalarText(child);
      if (text.includes('\n') || text.length > 90) {
        lines.push(`${indent}${label}:`, ...text.split('\n').map((line) => `${indent}  ${line}`));
      } else {
        lines.push(`${indent}${label}: ${text}`);
      }
      continue;
    }
    if (Array.isArray(child)) {
      if (child.every(isScalar)) {
        lines.push(`${indent}${label}: ${child.map((item) => scalarText(item as string | number | boolean | null)).join(', ')}`);
      } else if (depth < MAX_DEPTH) {
        lines.push(`${indent}${label}:`, ...renderArray(child, `${indent}  `, depth + 1));
      } else {
        lines.push(`${indent}${label}: (${child.length} items)`);
      }
      continue;
    }
    if (child && typeof child === 'object') {
      if (depth < MAX_DEPTH) {
        lines.push(`${indent}${label}:`, ...renderObject(child as Record<string, unknown>, `${indent}  `, depth + 1));
      } else {
        lines.push(`${indent}${label}: (details omitted)`);
      }
    }
  }
  return lines;
}

function renderArray(value: unknown[], indent: string, depth: number): string[] {
  const lines: string[] = [];
  value.forEach((item, index) => {
    if (index > 0) lines.push('');
    if (isScalar(item)) {
      lines.push(`${indent}${index + 1}. ${scalarText(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${indent}${index + 1}.`, ...renderArray(item, `${indent}   `, depth + 1));
    } else if (item && typeof item === 'object') {
      lines.push(`${indent}${index + 1}.`, ...renderObject(item as Record<string, unknown>, `${indent}   `, depth + 1));
    }
  });
  return lines;
}

/** Render a structured value for a human reviewer. Strings pass through. */
export function renderReviewValueForHumans(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isScalar(value)) return scalarText(value);
  if (Array.isArray(value)) return renderArray(value, '', 0).join('\n');
  if (value && typeof value === 'object') return renderObject(value as Record<string, unknown>, '', 0).join('\n');
  return '';
}

/** Render draft text for a human reviewer: JSON becomes readable prose
 *  lines; anything that is not JSON is returned as it was. */
export function renderReviewDraftForHumans(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return trimmed;
  try {
    return renderReviewValueForHumans(JSON.parse(trimmed)) || trimmed;
  } catch {
    return trimmed;
  }
}
