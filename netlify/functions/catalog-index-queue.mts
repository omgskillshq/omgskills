import type { Config } from "@netlify/functions";
import { scanDriverConfigFromEnv } from "./_shared/scan-driver.js";
import { signRequest } from "../../scanner/src/signature.js";

// Every hour, starts catalog-index-background, which rebuilds the content index My skills uses to
// recognize library skills installed from GitHub directly (only when a new catalog was published).
// Kept apart from the public scan: it runs whether or not that scan is on, and a failed build
// can't stop it. Signed with the scanner key, like the public scan's trigger.
export const config: Config = { schedule: "7 * * * *" };

export const CATALOG_INDEX_RUN_PATH = "/.netlify/functions/catalog-index-background";

export default async () => {
  const scanConfig = scanDriverConfigFromEnv();
  const site = process.env.URL?.replace(/\/+$/, "");
  if (!scanConfig || !site) return new Response(null, { status: 204 });
  const body = new Uint8Array();
  const headers = await signRequest(scanConfig.signingKey, "POST", CATALOG_INDEX_RUN_PATH, body);
  try {
    const response = await fetch(`${site}${CATALOG_INDEX_RUN_PATH}`, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (response.status !== 202) console.error("catalog index: build didn't start", { status: response.status });
  } catch (error) {
    console.error("catalog index: build didn't start", { error: error instanceof Error ? error.message : String(error) });
  }
  return new Response(null, { status: 204 });
};
