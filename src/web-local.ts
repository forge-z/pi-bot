import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

export class LocalPageError extends Error {}

const RESERVED = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  RESERVED.addSubnet(address, prefix);
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  RESERVED.addSubnet(address, prefix, "ipv6");
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !RESERVED.check(address);
  return (
    family === 6 &&
    GLOBAL_V6.check(address, "ipv6") &&
    !RESERVED.check(address, "ipv6")
  );
}

function assertPublicUrl(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    (isIP(host)
      ? !publicAddress(host)
      : !host.includes(".") ||
        /\.(?:localhost|local|internal|home\.arpa)$/i.test(host))
  )
    throw new LocalPageError(
      "Local extraction requires a public HTTP or HTTPS URL on a standard port",
    );
}

type LocalResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
};

export type LocalGet = (
  url: URL,
  signal: AbortSignal,
) => Promise<LocalResponse>;

const getPublicPage: LocalGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        agent: false,
        headers: {
          Accept: "text/html, application/xhtml+xml, text/plain",
          "Accept-Encoding": "identity",
        },
        lookup(host, options, done) {
          lookup(
            host.endsWith(".") ? host : `${host}.`,
            { all: true },
            (error, addresses) => {
              if (error) return done(error, "", 0);
              const first = addresses[0];
              if (
                !first ||
                addresses.some(({ address }) => !publicAddress(address))
              )
                return done(
                  new LocalPageError(
                    "page does not resolve to a public IP address",
                  ),
                  "",
                  0,
                );
              if (options.all) done(null, addresses);
              else done(null, first.address, first.family);
            },
          );
        },
        signal,
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          close: () => response.destroy(),
        }),
    );
    req.once("error", reject);
    req.end();
  });

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function htmlText(html: string) {
  return html
    .replace(
      /<\/?(?:address|article|blockquote|div|h[1-6]|li|main|p|pre|section|tr|br|hr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
      (match: string, entity: string) => {
        if (!entity.startsWith("#"))
          return ENTITIES[entity.toLowerCase()] ?? match;
        const value =
          entity[1]?.toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return value > 0 &&
          value <= 0x10ffff &&
          !(value >= 0xd800 && value <= 0xdfff)
          ? String.fromCodePoint(value)
          : match;
      },
    )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractLocalPage(
  input: string,
  signal: AbortSignal,
  maxBytes: number,
  maxChars: number,
  get: LocalGet = getPublicPage,
) {
  let url = new URL(input);
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    assertPublicUrl(url);
    url.hash = "";
    const response = await get(url, signal);
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 4 || !response.headers.location)
          throw new LocalPageError("page redirect failed");
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new LocalPageError(`page HTTP ${response.status}`);
      if (response.status === 204)
        return { url: url.href, title: "", text: "" };
      const contentType = response.headers["content-type"] ?? "";
      const encoding = response.headers["content-encoding"] ?? "identity";
      if (
        !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(
          contentType,
        ) ||
        encoding !== "identity"
      )
        throw new LocalPageError("unsupported page content type or encoding");
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new LocalPageError("response too large");
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      if (/^text\/plain\b/i.test(contentType))
        return { url: url.href, title: "", text: text.slice(0, maxChars) };
      const html = text
        .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
        .replace(
          /<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
          "",
        );
      const title = htmlText(
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "",
      ).slice(0, 300);
      const body =
        html.match(/<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i)?.[1] ??
        html.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "");
      const main =
        body.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2] ?? body;
      return { url: url.href, title, text: htmlText(main).slice(0, maxChars) };
    } finally {
      response.close();
    }
  }
}
