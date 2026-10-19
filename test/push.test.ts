import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encryptPayload, isValidSubscription } from "../src/push.ts";

// RFC 8291 Appendix A: a known-answer test for Web Push encryption.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encryption matches the RFC 8291 example byte for byte", async () => {
  const asPub = b64u.decode(RFC.asPublic);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: RFC.asPrivate,
    x: b64u.encode(asPub.slice(1, 33)),
    y: b64u.encode(asPub.slice(33, 65)),
  };
  const out = await encryptPayload(
    new TextEncoder().encode(RFC.plaintext),
    { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret } },
    { asPublic: asPub, asPrivate: jwk, salt: b64u.decode(RFC.salt) },
  );
  assert.equal(b64u.encode(out), RFC.expected);
});

test("only real push services are accepted", () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
  assert.equal(isValidSubscription({ endpoint: "https://web.push.apple.com/abc", keys }), true);
  assert.equal(isValidSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }), true);
  assert.equal(isValidSubscription({ endpoint: "https://evil.example.com/abc", keys }), false);
  assert.equal(isValidSubscription({ endpoint: "http://fcm.googleapis.com/abc", keys }), false);
  assert.equal(isValidSubscription({ endpoint: "https://fcm.googleapis.com/abc", keys: { p256dh: "short", auth: "x" } }), false);
});
