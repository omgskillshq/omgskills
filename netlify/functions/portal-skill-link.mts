import type { Config, Context } from "@netlify/functions";
import { handleSkillLinkChoice } from "./_shared/skill-link-choices.js";

// Which library skill a person's copy is, when several library skills share its content.
export default async (req: Request, _context: Context) => handleSkillLinkChoice(req);

export const config: Config = { path: "/api/portal/skill-link" };
