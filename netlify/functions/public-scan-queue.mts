import type { Config } from "@netlify/functions";
import { scanDriverConfigFromEnv } from "./_shared/scan-driver.js";
import { publicScanScopeFromEnv } from "./_shared/public-scan-driver.js";
import { signRequest } from "../../scanner/src/signature.js";

// Starts a public scan run in the background (scheduled functions stop at 30 s; an AI review can take
// longer). The run itself is public-scan-background; it only accepts requests signed like this one.
export const config: Config = { schedule: "*/15 * * * *" };

export const PUBLIC_SCAN_RUN_PATH = "/.netlify/functions/public-scan-background";

export default async () => {
  const scanConfig = scanDriverConfigFromEnv();
  const site = process.env.URL?.replace(/\/+$/, "");
  if (!scanConfig || !site || publicScanScopeFromEnv().length === 0) return new Response(null, { status: 204 });
  const body = new Uint8Array();
  const headers = await signRequest(scanConfig.signingKey, "POST", PUBLIC_SCAN_RUN_PATH, body);
  try {
    const response = await fetch(`${site}${PUBLIC_SCAN_RUN_PATH}`, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    // A background function answers 202 at once and keeps running.
    if (response.status !== 202) console.error("public scan: run didn't start", { status: response.status });
  } catch (error) {
    console.error("public scan: run didn't start", { error: error instanceof Error ? error.message : String(error) });
  }
  return new Response(null, { status: 204 });
};
