import { getStore } from "@netlify/blobs";
import { ensureContentIndex, readBlobContentIndex } from "./_shared/catalog-content-index.js";
import { getPgPool } from "./_shared/db.js";
import { linkSetItemsToLibrary } from "./_shared/set-library-links.js";
import { resolveCatalogPublicRelease } from "./_shared/public-releases.js";
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
  try {
    // Set items shared from My skills that turn out to be library skills follow the library.
    const blobs = getStore("catalog-index");
    const saved = await blobs.get("set-link-cursor.json", { type: "json" }) as { cursor?: unknown } | null;
    const linked = await linkSetItemsToLibrary(getPgPool(), {
      readIndex: readBlobContentIndex,
      resolveRelease: (catalogSkillId) => resolveCatalogPublicRelease(catalogSkillId),
      cursor: typeof saved?.cursor === "string" ? saved.cursor : null,
    });
    await blobs.setJSON("set-link-cursor.json", { cursor: linked.cursor });
    if (linked.linked || linked.skipped) console.info("set items linked to the library", { ...linked, cursor: undefined });
  } catch (error) {
    console.error("set items not linked", { error: error instanceof Error ? error.message : String(error) });
  }
};
