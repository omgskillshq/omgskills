import { getStore } from "@netlify/blobs";
import { ensureContentIndex } from "./_shared/catalog-content-index.js";
import { scanDriverConfigFromEnv } from "./_shared/scan-driver.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "../../scanner/src/signature.js";

// Rebuilds the catalog content index (Netlify Blobs "catalog-index") when a new catalog was
// published. Started hourly by catalog-index-queue; only accepts requests signed like it.
export default async (request: Request) => {
  const scanConfig = scanDriverConfigFromEnv();
  if (!scanConfig) return;
  const signed = await verifyRequest(scanConfig.signingKey, {
    method: request.method, path: new URL(request.url).pathname,
    timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER),
    body: new Uint8Array(await request.arrayBuffer())
  });
  if (!signed) {
    console.warn("catalog index: unsigned request ignored");
    return;
  }
  try {
    const blobs = getStore("catalog-index");
    const rebuilt = await ensureContentIndex({
      get: (key) => blobs.get(key, { type: "json" }),
      set: (key, value) => blobs.setJSON(key, value).then(() => undefined),
    });
    console.info(rebuilt ? "catalog index rebuilt" : "catalog index current");
  } catch (error) {
    console.error("catalog index not built", { error: error instanceof Error ? error.message : String(error) });
  }
};
