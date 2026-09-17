/**
 * Images inside tool results must reach the provider as images.
 *
 * The Agents SDK bridge writes an image tool output as a `media` content part.
 * The provider layer it feeds names the same thing `image-data` (inline bytes)
 * or `image-url`, and silently drops any part type it does not recognise, with
 * only a warning. The model then receives the tool's caption and never the
 * image it asked to look at. This wrapper renames the parts at the one seam
 * between the bridge and the provider, so every tool that returns an image is
 * seen, whatever tool produced it.
 */

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerContentPart(part: unknown): unknown {
  if (!isRecord(part) || part.type !== 'media') return part;
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType : '';
  const data = part.data;
  if (typeof data === 'string' && /^https?:\/\//i.test(data)) {
    return mediaType.startsWith('image/')
      ? { type: 'image-url', url: data }
      : { type: 'file-url', url: data };
  }
  if (mediaType.startsWith('image/') && mediaType !== 'image/*') {
    return { type: 'image-data', data, mediaType };
  }
  return { type: 'file-data', data, mediaType };
}

/** Tool-result images a single request carries. A model looking at its own
 *  work needs the latest renders, not every earlier one: each image costs
 *  context, and a request carrying many images is held to a smaller size per
 *  image, so an accumulated history of previews can fail the whole request. */
export const PROVIDER_TOOL_IMAGES_PER_REQUEST = 4;

const EARLIER_IMAGE_TEXT = '[An earlier image from this tool result is no longer attached. Call the tool again to see the current state.]';

function isMediaPart(item: unknown): boolean {
  return isRecord(item) && item.type === 'media';
}

/** Rewrite `media` parts in tool-result content to the provider's part names,
 *  attaching only the most recent tool-result images. Everything else is
 *  returned unchanged, including object identity when nothing needed
 *  rewriting. */
export function providerPromptWithToolMedia(
  prompt: unknown,
  maxImages: number = PROVIDER_TOOL_IMAGES_PER_REQUEST,
): unknown {
  if (!Array.isArray(prompt)) return prompt;
  let remaining = 0;
  for (const message of prompt) {
    if (!isRecord(message) || message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'tool-result' || !isRecord(part.output)) continue;
      if (part.output.type !== 'content' || !Array.isArray(part.output.value)) continue;
      remaining += part.output.value.filter(isMediaPart).length;
    }
  }
  if (remaining === 0) return prompt;
  // Images before the last `maxImages` are replaced, oldest first.
  let toDrop = Math.max(0, remaining - Math.max(0, maxImages));
  return prompt.map((message) => {
    if (!isRecord(message) || message.role !== 'tool' || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (!isRecord(part) || part.type !== 'tool-result' || !isRecord(part.output)) return part;
      const output = part.output;
      if (output.type !== 'content' || !Array.isArray(output.value)) return part;
      if (!output.value.some(isMediaPart)) return part;
      messageChanged = true;
      const value = output.value.map((item) => {
        if (!isMediaPart(item)) return item;
        if (toDrop > 0) {
          toDrop -= 1;
          return { type: 'text', text: EARLIER_IMAGE_TEXT };
        }
        return providerContentPart(item);
      });
      return { ...part, output: { ...output, value } };
    });
    return messageChanged ? { ...message, content } : message;
  });
}

/** Wrap a provider language model so tool-result images survive the bridge. */
export function withProviderToolMedia<T extends object>(model: T): T {
  return new Proxy(model, {
    get(target, property) {
      if (property === 'doGenerate' || property === 'doStream') {
        const method = Reflect.get(target, property, target) as unknown;
        if (typeof method !== 'function') return method;
        return (options: unknown) => {
          const rewritten = isRecord(options)
            ? { ...options, prompt: providerPromptWithToolMedia(options.prompt) }
            : options;
          return (method as (value: unknown) => unknown).call(target, rewritten);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
