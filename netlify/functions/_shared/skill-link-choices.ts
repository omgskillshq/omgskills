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
 * POST { matchKey, catalogSkillId }: which library skill the person's copies with this content are,
 * when several library skills share it; catalogSkillId null means "my own skill". The skill must be
 * one of the candidates the index lists for that content. Applies to every copy with that content.
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
    if (catalogSkillId !== null && (typeof catalogSkillId !== "string" || catalogSkillId.length < 1 || catalogSkillId.length > 500)) {
      return errorResponse(req, 400, "Invalid catalogSkillId");
    }
    // Only for something the library suggested (one match or several), "my own" included.
    let entries: Record<string, ContentIndexEntry>;
    try {
      entries = await deps.readContentIndex([body.matchKey]);
    } catch {
      return errorResponse(req, 503, "Library is unavailable; try again");
    }
    const ids = entries[body.matchKey]?.ids ?? [];
    if (!ids.length) return errorResponse(req, 404, "This skill has no library matches to choose from");
    if (catalogSkillId !== null && !ids.includes(catalogSkillId)) return errorResponse(req, 404, "Not one of this skill's library matches");
    const saved = await deps.getPgPool().query(
      `INSERT INTO skill_link_choices (user_id, match_key, catalog_skill_id)
       SELECT $1, $2, $3
       WHERE EXISTS (SELECT 1 FROM skill_link_choices WHERE user_id = $1 AND match_key = $2)
          OR (SELECT count(*) FROM skill_link_choices WHERE user_id = $1) < $4
       ON CONFLICT (user_id, match_key) DO UPDATE SET catalog_skill_id = EXCLUDED.catalog_skill_id, chosen_at = now()
       RETURNING match_key`,
      [user.id, body.matchKey, catalogSkillId, MAX_CHOICES_PER_USER],
    );
    if (!saved.rows.length) return errorResponse(req, 409, `Too many saved choices (${MAX_CHOICES_PER_USER})`);
    return jsonResponse(req, { matchKey: body.matchKey, catalogSkillId });
  } catch (error) {
    if (error instanceof Response) return errorResponse(req, error.status, await error.text());
    return errorResponse(req, 500, "Couldn't save the choice");
  }
}
