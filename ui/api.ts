import { TablesClientError, type TablesClient } from "agentic-tables/client";
import { createContext, useContext } from "react";

/** The client that the app calls. `App` gets it from its host: the page in `main.tsx`, or `mount` in `embed.tsx`. */
export const ClientContext = createContext<TablesClient | null>(null);

export function useClient(): TablesClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("The tables UI needs a client above it.");
  return client;
}

/** The text to show for a failed call. Field issues come first: they say what to fix. */
export function failure(error: unknown): string {
  if (error instanceof TablesClientError) {
    if (error.issues?.length) return error.issues.map((i) => `${i.field}: ${i.message}`).join(". ");
    if (error.code === "NETWORK") return "The API did not answer. Check that the Worker runs.";
    return error.message;
  }
  return "Something went wrong.";
}
