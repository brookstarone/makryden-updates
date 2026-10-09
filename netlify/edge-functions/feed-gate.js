// Makryden Release Hub — feed gate.
// /meos/feed.json and /meos/feed.json.sig are served only to a caller that
// sends "Authorization: Bearer <MEOS_FEED_TOKEN>". Everyone else gets 404,
// so the feed (and the package paths inside it) stays private.
// The token is a gate, not the trust anchor: MEOS still verifies every
// feed and package against the owner's signing key.
export default async (request, context) => {
  const want = Netlify.env.get("MEOS_FEED_TOKEN") || "";
  const got = request.headers.get("authorization") || "";
  const expected = "Bearer " + want;
  let same = want.length >= 32 && got.length === expected.length;
  if (same) {
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    same = diff === 0;
  }
  if (!same) return new Response("Not found\n", { status: 404, headers: { "Cache-Control": "no-store" } });
  const res = await context.next();
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  return out;
};

export const config = { path: ["/meos/feed.json", "/meos/feed.json.sig"] };
