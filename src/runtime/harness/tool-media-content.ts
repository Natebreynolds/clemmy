/**
 * A tool result that carries an image the model must SEE.
 *
 * External tools already deliver images as content blocks and the host projects
 * each `{ type: 'image', data, mimeType }` block into a model image. A local
 * tool or a carrier that flattens the same blocks to text hands the model a
 * base64 string instead: the tool "worked", and the model saw nothing. This is
 * the one recogniser every flattening boundary consults before it flattens.
 *
 * Only well-formed inline images count, and only alongside text blocks, so a
 * structured JSON answer is never mistaken for media.
 */

export type ToolMediaTextBlock = { type: 'text'; text: string };
export type ToolMediaImageBlock = { type: 'image'; data: string; mimeType: string };
export type ToolMediaContent = Array<ToolMediaTextBlock | ToolMediaImageBlock>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isToolMediaImageBlock(value: unknown): value is ToolMediaImageBlock {
  return isRecord(value)
    && value.type === 'image'
    && typeof value.data === 'string'
    && value.data.length > 0
    && typeof value.mimeType === 'string'
    && /^image\/[a-z0-9.+-]+$/i.test(value.mimeType);
}

function isToolMediaTextBlock(value: unknown): value is ToolMediaTextBlock {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

/** True when the value is content blocks holding at least one inline image and
 *  nothing but text and inline images. */
export function isToolMediaContent(value: unknown): value is ToolMediaContent {
  if (!Array.isArray(value) || value.length === 0) return false;
  let images = 0;
  for (const block of value) {
    if (isToolMediaImageBlock(block)) { images += 1; continue; }
    if (!isToolMediaTextBlock(block)) return false;
  }
  return images > 0;
}

/** The image blocks inside an MCP-style content list, exactly as produced. */
export function toolMediaImageBlocks(content: readonly unknown[]): ToolMediaImageBlock[] {
  return content
    .filter(isToolMediaImageBlock)
    .map((block) => ({ type: 'image', data: block.data, mimeType: block.mimeType }));
}

/** The text a media result shows wherever only text can travel. Images are
 *  named, never inlined as base64. */
export function toolMediaText(content: ToolMediaContent): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : `[image: ${block.mimeType}]`))
    .filter(Boolean)
    .join('\n');
}
