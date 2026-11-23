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
          Accept: "text/html, application/xhtml+xml",
          "Accept-Encoding": "identity",
          "User-Agent": "Mozilla/5.0 (compatible; pi-web-extract/1.0)",
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

function readableText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractHtml(
  html: string,
  url: URL,
  maxChars: number,
  signal: AbortSignal,
) {
  const [{ Readability }, { JSDOM }, { NodeHtmlMarkdown }] = await Promise.all([
    import("@mozilla/readability"),
    import("jsdom"),
    import("node-html-markdown"),
  ]);
  signal.throwIfAborted();
  const dom = new JSDOM(html, { url: url.href });
  try {
    const { document } = dom.window;
    const article = new Readability(
      document.cloneNode(true) as Document,
    ).parse();
    const title = article?.title || document.title.trim() || "Untitled page";
    let content: string;
    if (article) {
      content = NodeHtmlMarkdown.translate(article.content ?? "");
    } else {
      document
        .querySelectorAll(
          "script, style, noscript, svg, iframe, nav, footer, header",
        )
        .forEach((node) => node.remove());
      content =
        document.body?.textContent ||
        document.documentElement.textContent ||
        "";
    }
    signal.throwIfAborted();
    return {
      url: url.href,
      title: title.slice(0, 300),
      text: readableText(content).slice(0, maxChars),
    };
  } finally {
    dom.window.close();
  }
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
        (contentType && !contentType.toLowerCase().includes("html")) ||
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
      return await extractHtml(text, url, maxChars, signal);
    } finally {
      response.close();
    }
  }
}
