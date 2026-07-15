import { getFact } from './facts.js';
import { upsertEntity, type EntityIdentifierInput } from './entity-identity.js';
import { addFactEntityLinks } from './relations.js';

const NAME_TOKEN = String.raw`[A-Z][A-Za-z'’.-]{1,40}`;
const PERSON_NAME = String.raw`(${NAME_TOKEN}(?:\s+${NAME_TOKEN}){1,3})`;
const TERMINATED_PERSON_NAME = String.raw`(${NAME_TOKEN}(?:\s+${NAME_TOKEN}){1,3}?)(?=\s*(?:[,.;:()]|and\b|who\b|on\b|at\b|for\b|$))`;
const ROLE = String.raw`(?:chief\s+(?:executive|financial|operating|technology)\s+officer|CEO|CFO|COO|CTO|attorney|lawyer|counsel|accountant|advisor|adviser|manager|boss|assistant|reviewer|contact|colleague|coworker|doctor|physician|therapist|partner|spouse|wife|husband|daughter|son|mother|father|sister|brother|friend)`;
const ROLE_PREFIX = String.raw`(?:[a-z][a-z'-]*\s+){0,2}`;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const NON_PERSON_NAME_TOKENS = new Set([
  'company', 'corporation', 'corp', 'inc', 'llc', 'llp', 'project', 'team',
  'department', 'group', 'committee', 'speaker', 'participant', 'attendee',
  'host', 'guest', 'unknown', 'assistant', 'clementine',
]);

export interface GroundedUserPerson {
  name: string;
  identifiers: EntityIdentifierInput[];
  confidence: number;
  grounding: 'possessive_role' | 'reverse_role' | 'durable_collaboration';
}

export interface GroundedUserPeopleAttachment {
  extracted: number;
  observed: number;
  linked: number;
  entityIds: number[];
  failures: string[];
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[.,;:]+$/g, '').trim();
}

function validPersonName(value: string): boolean {
  const tokens = normalizeName(value).split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (tokens.some((token) => NON_PERSON_NAME_TOKENS.has(token.replace(/[^a-z]/gi, '').toLowerCase()))) return false;
  return tokens.every((token) => /^[A-Z][A-Za-z'’.-]*$/.test(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emailIdentifiersForName(source: string, name: string): EntityIdentifierInput[] {
  const emails = Array.from(new Set(source.match(EMAIL_RE) ?? []));
  const nameTokens = name.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const first = nameTokens[0]?.replace(/[^a-z0-9]/g, '') ?? '';
  const last = nameTokens.at(-1)?.replace(/[^a-z0-9]/g, '') ?? '';
  const adjacent = new RegExp(`${escapeRegExp(name)}\\s*(?:\\(|<|,|[-–—])?\\s*([\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+)`, 'i');
  const adjacentEmail = source.match(adjacent)?.[1]?.toLowerCase();
  return emails
    .filter((email) => {
      if (email.toLowerCase() === adjacentEmail) return true;
      const localTokens = email.toLowerCase().split('@', 1)[0].split(/[._+-]+/).filter(Boolean);
      return Boolean(first && last && localTokens.includes(first) && localTokens.includes(last));
    })
    .map((value) => ({ scheme: 'email', value, confidence: 0.98 }));
}

function addPerson(
  found: Map<string, GroundedUserPerson>,
  source: string,
  rawName: string,
  grounding: GroundedUserPerson['grounding'],
): void {
  const name = normalizeName(rawName);
  if (!validPersonName(name)) return;
  const key = name.toLowerCase();
  const identifiers = emailIdentifiersForName(source, name);
  const existing = found.get(key);
  if (existing) {
    const byValue = new Map(existing.identifiers.map((identifier) => [`${identifier.scheme}:${identifier.value.toLowerCase()}`, identifier]));
    for (const identifier of identifiers) byValue.set(`${identifier.scheme}:${identifier.value.toLowerCase()}`, identifier);
    existing.identifiers = Array.from(byValue.values());
    existing.confidence = Math.max(existing.confidence, identifiers.length > 0 ? 0.98 : 0.92);
    return;
  }
  found.set(key, {
    name,
    identifiers,
    confidence: identifiers.length > 0 ? 0.98 : 0.92,
    grounding,
  });
}

/**
 * Extract only people explicitly identified by a relationship in the user's
 * own statement. Capitalization alone is never enough: “Northstar Launch” does
 * not become a person, while “my CFO is Dana Wilson” does. This deliberately
 * favors precision over coverage because identities are durable graph nodes.
 */
export function extractGroundedUserPeople(sourceText: string): GroundedUserPerson[] {
  const source = sourceText.replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const found = new Map<string, GroundedUserPerson>();
  const patterns: Array<{ regex: RegExp; grounding: GroundedUserPerson['grounding'] }> = [
    {
      regex: new RegExp(String.raw`\b(?:my|our)\s+${ROLE_PREFIX}${ROLE}\s+(?:is|was|:|=)\s+${TERMINATED_PERSON_NAME}`, 'gi'),
      grounding: 'possessive_role',
    },
    {
      regex: new RegExp(String.raw`\b${PERSON_NAME}\s+(?:is|was)\s+(?:my|our)\s+${ROLE_PREFIX}${ROLE}\b`, 'gi'),
      grounding: 'reverse_role',
    },
    {
      regex: new RegExp(String.raw`\b(?:I|we)\s+(?:work|collaborate|coordinate)\s+with\s+${TERMINATED_PERSON_NAME}`, 'g'),
      grounding: 'durable_collaboration',
    },
    {
      regex: new RegExp(String.raw`\b(?:I|we)\s+report\s+to\s+${TERMINATED_PERSON_NAME}`, 'g'),
      grounding: 'durable_collaboration',
    },
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.regex)) {
      // The only capturing group in every expression is PERSON_NAME.
      addPerson(found, source, match[1] ?? '', pattern.grounding);
    }
  }
  return Array.from(found.values()).slice(0, 8);
}

function textMentionsExactName(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}(?=$|[^A-Za-z0-9])`, 'i').test(text);
}

/** Create/reuse canonical people from an exact user-turn episode and ground
 * fact links only when the canonical claim itself still names that person.
 * Replaying the same episode is idempotent in both entity_observations and
 * fact_entities. */
export function attachGroundedUserPeople(input: {
  factId?: number | null;
  episodeId: string;
  sourceText: string;
  sourceUri?: string | null;
}): GroundedUserPeopleAttachment {
  const people = extractGroundedUserPeople(input.sourceText);
  const result: GroundedUserPeopleAttachment = {
    extracted: people.length,
    observed: 0,
    linked: 0,
    entityIds: [],
    failures: [],
  };
  const fact = input.factId ? getFact(input.factId) : null;
  for (const person of people) {
    try {
      const namedInFact = Boolean(fact && textMentionsExactName(fact.content, person.name));
      const entityId = upsertEntity({
        type: 'person',
        name: person.name,
        identifiers: person.identifiers,
        confidence: person.confidence,
        evidenceEpisodeId: input.episodeId,
        sourceUri: input.sourceUri ?? undefined,
        sourceFactId: namedInFact ? fact!.id : undefined,
        sourceKind: 'user_turn',
      });
      result.entityIds.push(entityId);
      result.observed += 1;
      if (namedInFact) {
        addFactEntityLinks(fact!.id, [entityId], {
          linkType: 'extracted',
          confidence: person.confidence,
          evidenceEpisodeId: input.episodeId,
          evidenceExcerpt: input.sourceText,
          sourceUri: input.sourceUri ?? undefined,
          sourceKind: 'fact_link',
          incrementMention: false,
        });
        result.linked += 1;
      }
    } catch (error) {
      result.failures.push(`${person.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 220));
    }
  }
  result.entityIds = Array.from(new Set(result.entityIds));
  return result;
}
