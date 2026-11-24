import { getStore } from "@netlify/blobs";
import { ensureContentIndex, readBlobContentIndex } from "./_shared/catalog-content-index.js";
import { getPgPool } from "./_shared/db.js";
import { linkSetItemsToLibrary } from "./_shared/set-library-links.js";
import { computeContentMatches } from "./_shared/content-match.js";
import { createCloudObjectStore } from "./_shared/cloud-store.js";
import { loadPublishedSkills } from "./_shared/published-catalog.js";
import { resolveCatalogPublicRelease } from "./_shared/public-releases.js";
import { scanDriverConfigFromEnv } from "./_shared/scan-driver.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "../../scanner/src/signature.js";

// Rebuilds the catalog content index (Netlify Blobs "catalog-index") when a new catalog was
// published. Started hourly by catalog-index-queue; only accepts requests signed like it.
export default async (request: Request) => {
  const startedAt = Date.now();
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
    // Compare the text of personal copies with same-named library skills (results confirm links).
    const blobs = getStore("catalog-index");
    const meta = await blobs.get("meta.json", { type: "json" }) as { catalogKey?: unknown } | null;
    if (typeof meta?.catalogKey === "string") {
      // The full catalog (about 88 MB) is read only once a version actually needs comparing.
      let skills: Map<string, unknown> | null = null;
      const skillsById = async () => skills ??= new Map<string, unknown>((await loadPublishedSkills()).flatMap((skill) => typeof skill.id === "string" ? [[skill.id, skill] as [string, unknown]] : []));
      const matched = await computeContentMatches(getPgPool(), {
        store: createCloudObjectStore(),
        readIndex: readBlobContentIndex,
        catalogKey: meta.catalogKey,
        // Eight minutes from the start of the whole run, leaving time for the Set step after it.
        budgetMs: Math.max(0, 8 * 60_000 - (Date.now() - startedAt)),
        async catalogSkill(id) {
          const skill = (await skillsById()).get(id) as Record<string, unknown> | undefined;
          if (!skill) return null;
          const repo = typeof skill.repo_slug === "string" ? skill.repo_slug : id.split(":")[0];
          const url = typeof skill.repo_commit_sha === "string" && typeof skill.skill_md_path === "string"
            ? `https://raw.githubusercontent.com/${repo}/${skill.repo_commit_sha}/${skill.skill_md_path.split("/").map(encodeURIComponent).join("/")}` : null;
          return { name: String(skill.name ?? ""), description: String(skill.description ?? ""), url };
        },
        async fetchText(url) {
          const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          // Gone or refused for good (404, 403, 451…): left out. Rate limits and server errors: thrown, so
          // it's tried again next run.
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return null;
          if (!response.ok) throw new Error(`library skill text ${response.status}`);
          if (Number(response.headers.get("content-length") ?? 0) > 1_000_000) return null;
          const text = await response.text();
          return text.length > 1_000_000 ? null : text;
        },
      });
      if (matched.checked) console.info("content matches compared", matched);
    }
  } catch (error) {
    console.error("content matches not compared", { error: error instanceof Error ? error.message : String(error) });
  }
  try {
    // Set items shared from My skills that turn out to be library skills follow the library.
    const blobs = getStore("catalog-index");
    const saved = await blobs.get("set-link-cursor.json", { type: "json" }) as { cursor?: unknown } | null;
    // Per-item failures are counted, not thrown, so the cursor is always saved and the job moves on.
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
