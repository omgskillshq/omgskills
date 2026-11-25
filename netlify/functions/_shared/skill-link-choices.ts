import { getPgPool } from "./db.js";
import { isMatchKey, readBlobContentIndex, type ContentIndexEntry } from "./catalog-content-index.js";
import { errorResponse, jsonResponse, optionsResponse, withTimeout } from "./http.js";
import { requirePortalUser } from "./user.js";
import { requireJsonObject } from "./validation.js";

type QueryPool = Pick<ReturnType<typeof getPgPool>, "query">;

/** Most library-match choices one person keeps. */
export const MAX_CHOICES_PER_USER = 2000;

const defaults = {
  getPgPool: (): QueryPool => getPgPool(),
  requirePortalUser: (req: Request) => requirePortalUser(req),
  readContentIndex: (keys: string[]): Promise<Record<string, ContentIndexEntry>> => withTimeout(readBlobContentIndex(keys), 5_000),
};
export type SkillLinkDependencies = typeof defaults;

/**
 * POST { matchKey, catalogSkillId, nameKey? }: which library skill the person's copies with this content
 * are, when several library skills share it; catalogSkillId null means "my own skill". The skill must be
 * one of the candidates the index lists for that content, or (with nameKey, the copies' name) another
 * library skill with that name, kept as the creator it's shown under. With noneOf: true (and catalogSkillId
 * null), "none of these": the library skills listed now are saved, so it's asked again only when another
 * turns up. Applies to every copy with that content.
 */
export async function handleSkillLinkChoice(req: Request, overrides: Partial<SkillLinkDependencies> = {}): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse(req);
  const deps = { ...defaults, ...overrides };
  try {
    if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
    const user = await deps.requirePortalUser(req);
    const body = await requireJsonObject(req);
    if (!isMatchKey(body.matchKey)) return errorResponse(req, 400, "Invalid matchKey");
    const catalogSkillId = body.catalogSkillId;
    const noneOf = body.noneOf === true;
    if (body.noneOf !== undefined && typeof body.noneOf !== "boolean") return errorResponse(req, 400, "Invalid noneOf");
    if (noneOf && catalogSkillId !== null) return errorResponse(req, 400, "None of these takes no library skill");
    if (catalogSkillId !== null && (typeof catalogSkillId !== "string" || catalogSkillId.length < 1 || catalogSkillId.length > 500)) {
      return errorResponse(req, 400, "Invalid catalogSkillId");
    }
    // Only for something the library suggested (one match or several), "my own" included.
    let entries: Record<string, ContentIndexEntry>;
    try {
      entries = await deps.readContentIndex(typeof body.nameKey === "string" && /^n:[0-9a-f]{64}$/.test(body.nameKey)
        ? [body.matchKey, body.nameKey] : [body.matchKey]);
    } catch {
      return errorResponse(req, 503, "Library is unavailable; try again");
    }
    const ids = entries[body.matchKey]?.ids ?? [];
    if (!ids.length) return errorResponse(req, 404, "This skill has no library matches to choose from");
    // Another skill with the copies' name: the name's list must hold it and share a candidate (same name).
    const named = typeof body.nameKey === "string" ? entries[body.nameKey]?.ids ?? [] : [];
    const keptByName = typeof catalogSkillId === "string" && named.includes(catalogSkillId) && ids.some((id) => named.includes(id));
    if (catalogSkillId !== null && !ids.includes(catalogSkillId) && !keptByName) return errorResponse(req, 404, "Not one of this skill's library matches");
    const saved = await deps.getPgPool().query(
      `INSERT INTO skill_link_choices (user_id, match_key, catalog_skill_id, none_of)
       SELECT $1, $2, $3, $5::text[]
       WHERE EXISTS (SELECT 1 FROM skill_link_choices WHERE user_id = $1 AND match_key = $2)
          OR (SELECT count(*) FROM skill_link_choices WHERE user_id = $1) < $4
       ON CONFLICT (user_id, match_key) DO UPDATE SET catalog_skill_id = EXCLUDED.catalog_skill_id, none_of = EXCLUDED.none_of, chosen_at = now()
       RETURNING match_key`,
      [user.id, body.matchKey, catalogSkillId, MAX_CHOICES_PER_USER, noneOf ? ids.slice(0, 500) : null],
    );
    if (!saved.rows.length) return errorResponse(req, 409, `Too many saved choices (${MAX_CHOICES_PER_USER})`);
    return jsonResponse(req, { matchKey: body.matchKey, catalogSkillId, ...(noneOf ? { noneOf: true } : {}) });
  } catch (error) {
    if (error instanceof Response) return errorResponse(req, error.status, await error.text());
    return errorResponse(req, 500, "Couldn't save the choice");
  }
}
