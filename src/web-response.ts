export const MAX_RESPONSE_BYTES = 512 * 1024;

export class WebError extends Error {}

export async function readJson(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new WebError(`HTTP ${response.status}`);
  }
  if (!response.body) throw new WebError("invalid response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let json = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new WebError("response too large");
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}
