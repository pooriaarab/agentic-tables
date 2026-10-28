import { MigrationError } from "./migrate.js";
import { TablesError, ValidationError } from "./model.js";

/** The JSON body for a failed call. It holds codes and field names, never row content. */
export function errorBody(error: unknown): { error: { code: string; message: string; issues?: unknown; report?: unknown } } {
  if (error instanceof ValidationError) return { error: { code: error.code, message: error.message, issues: error.issues } };
  if (error instanceof MigrationError) return { error: { code: error.code, message: error.message, report: error.report } };
  if (error instanceof TablesError) return { error: { code: error.code, message: error.message } };
  return { error: { code: "ERROR", message: error instanceof Error ? error.message : String(error) } };
}
