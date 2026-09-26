/**
 * What the person attached, described the way the composer shows it. Pure so
 * the composer's chips and the sent bubble agree.
 */
import type { ChatAttachment } from '@clem/chat-engine';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

export function attachmentKind(name: string, mimeType?: string | null): ChatAttachment['kind'] {
  if (mimeType && mimeType.startsWith('image/')) return 'image';
  return IMAGE_EXT.test(name) ? 'image' : 'file';
}

/** "photo.heic" → "photo", "Q3 plan.pdf" → "Q3 plan.pdf" (a document keeps its extension). */
export function attachmentLabel(attachment: Pick<ChatAttachment, 'name' | 'kind'>): string {
  const name = attachment.name.trim() || (attachment.kind === 'image' ? 'Photo' : 'File');
  if (attachment.kind === 'image') return name.replace(IMAGE_EXT, '') || 'Photo';
  return name;
}

/** The one line under a sent bubble: "2 photos", "1 photo, 1 file". */
export function attachmentsSummary(attachments: ReadonlyArray<Pick<ChatAttachment, 'kind'>>): string {
  const images = attachments.filter((a) => a.kind === 'image').length;
  const files = attachments.length - images;
  return [
    images ? `${images} ${images === 1 ? 'photo' : 'photos'}` : '',
    files ? `${files} ${files === 1 ? 'file' : 'files'}` : '',
  ].filter(Boolean).join(', ');
}

/** Files above this are refused on the phone before any upload starts. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
