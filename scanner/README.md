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
  - On its own route, `POST /review`, so it never slows or re-runs the rule scans. Public skills only: it sends the
    files to Anthropic, so the private queue never calls it. `GET /scanners` lists it apart, under `review`.
  - One try per call (45 s limit, no SDK retries); the caller retries later.
  - Needs the `ANTHROPIC_API_KEY` secret; without it `/review` returns 503.
  - Text files only. Skills over 500k characters, or with a file it can't read (a PDF, document, archive or program;
    pictures, fonts and media are fine), get `partial`, never a cut-short pass.
  - Findings name the verdict and checks, never the quoted text.
  - "Suspicious", "malicious" or a refusal means a second look, never a public label on its own.
- `ai-second-look` (same file, `SECOND_LOOK`): Claude Opus reads the same files with the same prompt, on
  `POST /second-look`, only for public skills the AI review or the rules flagged (120 s limit, one try). Tested in
  the scanner trial, round 5. What it also flags, or refuses, waits for a person. Listed under `secondLook`.
  - The prompt is the one tested in the scanner trial; its hash is pinned in the tests, so a change needs a new trial and version.

Routes (all signed): `POST /scan`, `POST /review`, `POST /second-look`, `GET /scanners`, `GET /selftest` (shows the container can't reach the internet).

## Run

```bash
npm install            # in scanner/
npm test
npm run typecheck
npm run deploy         # build, check, then wrangler deploy (needs the Cloudflare token, SCAN_SIGNING_KEY and ANTHROPIC_API_KEY secrets)
```
