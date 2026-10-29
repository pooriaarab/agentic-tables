// A `fetch` for the Firestore emulator. The emulator hangs on a document read that carries
// `?transaction=<id>`, and answers the same read when it is sent as `documents:batchGet`. This turns
// the one into the other. Real Firestore takes both. Test and local use only.
export function emulatorFetch(inner: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const transaction = url.searchParams.get("transaction");
    const at = url.pathname.indexOf("/documents/");
    if ((init?.method ?? "GET") !== "GET" || transaction === null || at < 0) return inner(input, init);
    const root = url.pathname.slice(0, at + "/documents".length);
    const document = url.pathname.slice(1);
    const batch = new URL(`${root}:batchGet`, url);
    const response = await inner(batch, {
      ...init,
      method: "POST",
      headers: { ...(init?.headers as Record<string, string> | undefined), "content-type": "application/json" },
      body: JSON.stringify({ documents: [decodeURIComponent(document).replace(/^v1\//, "")], transaction }),
    });
    if (!response.ok) return response;
    const [answer] = (await response.json()) as { found?: unknown }[];
    if (answer?.found) return Response.json(answer.found);
    return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
  };
}
