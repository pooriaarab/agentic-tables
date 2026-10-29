import { createClient, TablesClientError } from "agentic-tables/client";

// The Worker reads the caller from headers and proves nothing yet, so this UI is for a local Worker.
export const client = createClient({ baseUrl: location.origin, principal: { id: "local-user", kind: "human" } });

/** The text to show for a failed call. Field issues come first: they say what to fix. */
export function failure(error: unknown): string {
  if (error instanceof TablesClientError) {
    if (error.issues?.length) return error.issues.map((i) => `${i.field}: ${i.message}`).join(". ");
    if (error.code === "NETWORK") return "The API did not answer. Check that the Worker runs.";
    return error.message;
  }
  return "Something went wrong.";
}
