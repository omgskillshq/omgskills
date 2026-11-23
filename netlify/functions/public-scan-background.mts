import { getPgPool } from "./_shared/db.js";
import { scanDriverConfigFromEnv } from "./_shared/scan-driver.js";
import {
  catalogTargetLoader, githubFileReader, publicScanScopeFromEnv, runPublicScanQueue
} from "./_shared/public-scan-driver.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "../../scanner/src/signature.js";

// Scans curated public skills: our rules and the AI review, files read from GitHub at the pinned
// commit. Started every 15 minutes by public-scan-queue, signed with the scanner key; runs up to
// 12 minutes. Results aren't shown publicly yet. PUBLIC_SCAN_SCOPE: "topics" (default),
// "topics,creators", or "off".
export default async (request: Request) => {
  const scanConfig = scanDriverConfigFromEnv();
  const scopes = publicScanScopeFromEnv();
  if (!scanConfig || scopes.length === 0) return;
  const signed = await verifyRequest(scanConfig.signingKey, {
    method: request.method, path: new URL(request.url).pathname,
    timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER),
    body: new Uint8Array(await request.arrayBuffer())
  });
  if (!signed) {
    console.warn("public scan: unsigned request ignored");
    return;
  }
  try {
    const result = await runPublicScanQueue(getPgPool(), {
      config: scanConfig,
      ...catalogTargetLoader(scopes),
      readFiles: githubFileReader(process.env.GITHUB_PUBLIC_READ_TOKEN?.trim() || undefined)
    });
    console.info("public scan", result);
  } catch (error) {
    // Only a code or message, never file contents.
    console.error("public scan run failed; trying again next run", { error: error instanceof Error ? error.message : String(error) });
  }
};
