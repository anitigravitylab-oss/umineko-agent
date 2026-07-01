const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

export function extractImageUrls(message) {
  if (!message.attachments?.size) return [];
  return [...message.attachments.values()]
    .filter((a) => a.contentType?.startsWith('image/') && a.contentType !== 'image/svg+xml')
    .filter((a) => !a.size || a.size <= MAX_IMAGE_BYTES)
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .map((a) => a.url);
}
