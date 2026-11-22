# Skill scanner

Scans skill files and reports findings. It runs on our Cloudflare account, separate from the rest of the app.

- `src/worker.ts`: the Worker.
  - Accepts only requests signed with `SCAN_SIGNING_KEY`.
  - Reads saved files through the `CLOUD_FILES` R2 binding, so it holds no keys. Private GitHub files arrive inline.
  - Checks every file against its hash and the skill's tree hash, then hands the files to the container.
- `container/`: the scanner image.
  - Runs with internet off, as an unprivileged user, and never runs skill code.
  - Each scanner is a module in `container/src/scanners/`, listed in `index.ts`.
  - A scanner that fails reports `failed`, never clean.
- Findings name the rule, file and line, never the matched text.
- Results are stored per content hash and scanner version (`skill_scans`), so a new version re-scans.
- `omg-rules` is versioned by a hash of `netlify/functions/_shared/skill-scan.ts`, so any rule change re-scans.
- `ai-review` (`src/ai-review.ts`): Claude Haiku answers a fixed checklist, then gives a verdict: clear, caution,
  suspicious or malicious. It runs in the Worker, because the container has no internet.
  - Only when a scan sends `aiReview: true`. Public skills only: it sends the files to Anthropic, so private scans never ask.
  - Needs the `ANTHROPIC_API_KEY` secret; a scan that asks without it gets a 503.
  - Text files only. Skills over 500k characters get `partial`, never a cut-short pass.
  - Findings name the verdict and checks, never the quoted text.
  - "Suspicious", "malicious" or a refusal means a second look, never a public label on its own.
  - The prompt is the one tested in the scanner trial; its hash is pinned in the tests, so a change needs a new trial and version.

Routes (all signed): `POST /scan`, `GET /scanners`, `GET /selftest` (shows the container can't reach the internet).

## Run

```bash
npm install            # in scanner/
npm test
npm run typecheck
npm run deploy         # build, check, then wrangler deploy (needs the Cloudflare token, SCAN_SIGNING_KEY and ANTHROPIC_API_KEY secrets)
```
