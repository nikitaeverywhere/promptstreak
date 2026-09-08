import type { Metrics } from "./types.js";

/**
 * Metrics <-> URL payload.
 *
 * The CLI encodes in Node and the browser decodes, so both paths live here and
 * are covered by the same round-trip test. A mismatch would silently break
 * every shared link, which is why there is exactly one implementation.
 *
 * The payload rides in the URL *fragment*, so it never reaches the server.
 */

const RAW = "0";
const GZIP = "1";

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
};

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "function") {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    void writer.write(bytes as unknown as BufferSource);
    void writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  try {
    const { gzipSync } = await import("node:zlib");
    return new Uint8Array(gzipSync(bytes));
  } catch {
    return null;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "function") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    void writer.write(bytes as unknown as BufferSource);
    void writer.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  const { gunzipSync } = await import("node:zlib");
  return new Uint8Array(gunzipSync(bytes));
}

/** What actually travels. Day arrays stay dense; gzip handles the zeros. */
export interface Payload {
  v: 1;
  from: string;
  to: string;
  series: Metrics["series"];
  aux: Metrics["aux"];
  stats: Metrics["stats"];
  label?: string;
}

export function toPayload(m: Metrics, label?: string): Payload {
  return { v: 1, from: m.from, to: m.to, series: m.series, aux: m.aux, stats: m.stats, ...(label ? { label } : {}) };
}

export async function encode(m: Metrics, label?: string): Promise<string> {
  const json = JSON.stringify(toPayload(m, label));
  const bytes = new TextEncoder().encode(json);
  const zipped = await gzip(bytes);
  return zipped && zipped.length < bytes.length
    ? GZIP + toBase64Url(zipped)
    : RAW + toBase64Url(bytes);
}

export async function decode(payload: string): Promise<Payload> {
  const tag = payload[0];
  const body = fromBase64Url(payload.slice(1));
  const bytes = tag === GZIP ? await gunzip(body) : body;
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (parsed?.v !== 1) throw new Error(`Unsupported payload version: ${parsed?.v}`);
  return parsed as Payload;
}
