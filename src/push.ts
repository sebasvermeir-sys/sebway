// Web Push without libraries: VAPID signing (RFC 8292) + aes128gcm payload encryption (RFC 8291/8188),
// using only WebCrypto so it runs in a Worker.

const enc = new TextEncoder();

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping the notification opens the app. */
  url?: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag?: string;
  /** With a tag: still buzz when replacing (each live journey step). */
  renotify?: boolean;
}

export const b64u = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s: string): Uint8Array {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
  },
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

/** Push services Sebway may send to. Anything else is refused, so the Worker can't be used to POST elsewhere. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

export function isValidSubscription(sub: unknown): sub is PushSubscriptionData {
  const s = sub as PushSubscriptionData;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1000) return false;
  if (typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return false;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((h) => h.test(url.hostname))) return false;
  try {
    return b64u.decode(s.keys.p256dh).length === 65 && b64u.decode(s.keys.auth).length === 16;
  } catch {
    return false;
  }
}

/** RFC 8291 encryption. `fixed` is only for tests (known keys and salt). */
export async function encryptPayload(
  payload: Uint8Array,
  sub: PushSubscriptionData,
  fixed?: { asPublic: Uint8Array; asPrivate: JsonWebKey; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = b64u.decode(sub.keys.p256dh);
  const authSecret = b64u.decode(sub.keys.auth);

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed) {
    asPrivate = await crypto.subtle.importKey("jwk", fixed.asPrivate, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublic = fixed.asPublic;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }

  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPrivate, 256));

  // HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public) → IKM
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));

  // HKDF(salt, IKM) → content encryption key and nonce
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  // One record: payload followed by the 0x02 "last record" delimiter, no padding.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(payload, new Uint8Array([2])) as BufferSource),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export async function vapidHeader(endpoint: string, env: Pick<Env, "VAPID_PRIVATE_JWK" | "VAPID_PUBLIC_KEY" | "VAPID_SUBJECT">): Promise<string> {
  const jwtHeader = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.encode(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })),
  );
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto returns the raw r||s signature, which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${jwtHeader}.${claims}`)));
  return `vapid t=${jwtHeader}.${claims}.${b64u.encode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export interface PushResult {
  ok: boolean;
  /** The subscription no longer exists: delete it. */
  gone: boolean;
  status: number;
}

export async function sendPush(env: Env, sub: PushSubscriptionData, message: PushMessage, ttlSeconds = 3600): Promise<PushResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "high",
    },
    body: body as BodyInit,
  });
  if (!res.ok) console.error(`push failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
}
