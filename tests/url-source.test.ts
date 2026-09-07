import { describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import {
  assertSafeUrl,
  isPrivateHost,
  htmlToText,
  fetchUrlSource,
  UrlSourceError,
  MAX_URL_BYTES,
  type LookupAllFn,
} from "../src/core/sources/url.js";
import { isPrivateIp } from "../src/core/sources/safe-fetch.js";

type LookupFn = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

function fakeLookupFn(addresses: LookupAddress[] | ((host: string) => LookupAddress[])): LookupFn {
  const resolve = typeof addresses === "function" ? addresses : () => addresses;
  return (async (host: string) => resolve(host)) as unknown as LookupFn;
}

const PUBLIC: LookupAddress[] = [{ address: "93.184.216.34", family: 4 }];

function htmlResponse(body: string, contentType = "text/html; charset=utf-8"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("URL safety guards", () => {
  it("refuses non-http protocols", () => {
    expect(() => assertSafeUrl("ftp://example.com/doc")).toThrow(UrlSourceError);
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(UrlSourceError);
    try {
      assertSafeUrl("javascript:alert(1)");
    } catch (err) {
      expect((err as UrlSourceError).code).toBe("url_bad_protocol");
    }
  });

  it("refuses embedded credentials", () => {
    expect(() => assertSafeUrl("https://user:pass@example.com/x")).toThrow(/credentials/);
  });

  it("classifies private hosts and IPs", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
    expect(isPrivateHost("box.internal")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.2", "172.16.0.9", "169.254.1.1", "0.0.0.0", "::1", "fe80::1", "fd00::5", "::ffff:127.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("refuses URLs whose host resolves to a private address (SSRF)", async () => {
    await expect(
      fetchUrlSource("https://evil.example.com/doc", {
        fetchImpl: (async () => htmlResponse("<p>x</p>")) as typeof fetch,
        lookupImpl: fakeLookupFn([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("refuses mixed record sets containing any private address", async () => {
    await expect(
      fetchUrlSource("https://sneaky.example.com/doc", {
        fetchImpl: (async () => htmlResponse("<p>x</p>")) as typeof fetch,
        lookupImpl: fakeLookupFn([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ]),
      }),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("re-validates redirect targets against the SSRF guard", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://internal.example.com/secret" } });
      }
      return htmlResponse("<p>should not get here</p>");
    }) as unknown as typeof fetch;
    const fakeLookup = fakeLookupFn((host: string) =>
      host.includes("internal") ? [{ address: "192.168.0.10", family: 4 }] : PUBLIC,
    );
    await expect(
      fetchUrlSource("https://public.example.com/doc", { fetchImpl: fakeFetch, lookupImpl: fakeLookup }),
    ).rejects.toMatchObject({ code: "url_private_host" });
    expect(calls).toHaveLength(1);
  });

  it("caps redirect chains", async () => {
    const fakeFetch = (async () =>
      new Response(null, { status: 302, headers: { location: "https://loop.example.com/a" } })) as unknown as typeof fetch;
    await expect(
      fetchUrlSource("https://start.example.com/doc", { fetchImpl: fakeFetch, lookupImpl: fakeLookupFn(PUBLIC) }),
    ).rejects.toMatchObject({ code: "url_too_many_redirects" });
  });

  it("rejects non-text content types and oversized payloads", async () => {
    const lookup = fakeLookupFn(PUBLIC);
    await expect(
      fetchUrlSource("https://example.com/b.tar.gz", {
        fetchImpl: async () => new Response("binary", { status: 200, headers: { "content-type": "application/octet-stream" } }),
        lookupImpl: lookup,
      }),
    ).rejects.toMatchObject({ code: "url_bad_content_type" });
    await expect(
      fetchUrlSource("https://example.com/big", {
        fetchImpl: async () =>
          new Response("x".repeat(MAX_URL_BYTES + 10), {
            status: 200,
            headers: { "content-type": "text/plain", "content-length": String(MAX_URL_BYTES + 10) },
          }),
        lookupImpl: lookup,
      }),
    ).rejects.toMatchObject({ code: "url_too_large" });
  });
});

describe("URL ingestion end-to-end deadline", () => {
  it("fails with url_deadline_exceeded when headers arrive but the body stalls", async () => {
    // Stream that never ends: only the shared deadline can end the read.
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const t0 = Date.now();
    await expect(
      fetchUrlSource("https://example.com/slow-body", {
        fetchImpl: (async () =>
          new Response(stalled, { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch,
        lookupImpl: fakeLookupFn(PUBLIC),
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "url_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("does not restart the deadline on every redirect hop", async () => {
    // Each hop answers quickly but takes 80 ms; the 200 ms global budget must
    // abort the CHAIN (old behavior restarted a fresh timeout per hop).
    let hops = 0;
    const slowRedirect = (async () => {
      hops += 1;
      await new Promise((r) => setTimeout(r, 80));
      return new Response(null, { status: 302, headers: { location: `https://next${hops}.example.com/x` } });
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(
      fetchUrlSource("https://start.example.com/x", {
        fetchImpl: slowRedirect,
        lookupImpl: fakeLookupFn(PUBLIC),
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "url_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(hops).toBeGreaterThanOrEqual(2);
    expect(hops).toBeLessThanOrEqual(4);
  });

  it("bounds stalled DNS validation with the same deadline", async () => {
    const never = new Promise<LookupAddress[]>(() => {});
    const t0 = Date.now();
    await expect(
      fetchUrlSource("https://slow-dns.example.com/x", {
        lookupImpl: (async () => never) as unknown as LookupAllFn,
        timeoutMs: 150,
      }),
    ).rejects.toMatchObject({ code: "url_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("htmlToText", () => {
  it("converts structure to markdown-ish text without scripts", () => {
    const { text, title } = htmlToText(
      `<html><head><title>Guide</title></head><body>
        <nav>menu junk</nav>
        <h1>Install</h1>
        <p>Run the installer. It is safe.</p>
        <script>alert("evil")</script>
        <pre>npm install thing</pre>
        <ul><li>First item</li><li>Second item</li></ul>
        <footer>copyright junk</footer>
      </body></html>`,
    );
    expect(title).toBe("Guide");
    expect(text).toContain("# Install");
    expect(text).toContain("```");
    expect(text).toContain("npm install thing");
    expect(text).toContain("- First item");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("menu junk");
    expect(text).not.toContain("copyright junk");
  });

  it("decodes entities in headings and body", () => {
    const { text } = htmlToText("<h1>Setup &amp; Config</h1><p>Use &lt;tag&gt; carefully.</p>");
    expect(text).toContain("Setup & Config");
    expect(text).toContain("<tag>");
  });
});

describe("fetchUrlSource end-to-end (injected fetch)", () => {
  it("converts an HTML page into a usable source input", async () => {
    const lookup = fakeLookupFn(PUBLIC);
    const page = `<!doctype html><html><head><title>Widget API Guide</title></head><body>
      <h1>Widget API</h1>
      <p>The Widget API lets you create and manage widgets. All requests need an API key.</p>
      <h2>Setup</h2>
      <pre>npm install @widgets/sdk</pre>
      <h2>Creating widgets</h2>
      <ol><li>Call createWidget with a name.</li><li>Poll the status endpoint.</li><li>Verify the widget is active.</li></ol>
      <p>Warning: never share your API key in client code.</p>
      </body></html>`;
    const result = await fetchUrlSource("https://docs.example.com/widgets/guide", {
      fetchImpl: (async () => htmlResponse(page)) as typeof fetch,
      lookupImpl: lookup,
    });
    expect(result.finalUrl).toBe("https://docs.example.com/widgets/guide");
    expect(result.input.name).toBe("Widget API Guide");
    expect(result.input.content).toContain("# Setup");
    expect(result.input.content).toContain("npm install @widgets/sdk");
    expect(result.notes.some((n) => n.includes("HTML converted"))).toBe(true);
  });

  it("reports JavaScript-rendered pages honestly", async () => {
    const lookup = fakeLookupFn(PUBLIC);
    await expect(
      fetchUrlSource("https://spa.example.com/app", {
        fetchImpl: (async () => htmlResponse('<!doctype html><html><body><div id="root"></div></body></html>')) as typeof fetch,
        lookupImpl: lookup,
      }),
    ).rejects.toMatchObject({ code: "url_no_content" });
  });

  it("treats plain markdown responses verbatim", async () => {
    const lookup = fakeLookupFn(PUBLIC);
    const result = await fetchUrlSource("https://example.com/README.md", {
      fetchImpl: (async () => htmlResponse("# Plain\n\nMarkdown body with enough content to pass the minimum length check for ingestion.", "text/markdown")) as typeof fetch,
      lookupImpl: lookup,
    });
    expect(result.input.content.startsWith("# Plain")).toBe(true);
    expect(result.notes.some((n) => n.includes("HTML converted"))).toBe(false);
  });
});
