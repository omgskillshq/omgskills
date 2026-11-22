// Safety scan for files saved to the cloud. Secrets hold a file back until the
// user confirms it; everything else only labels the skill. Findings never carry
// the matched text, only what was found and where.

export type SkillLabel =
  | "scripts"
  | "download_and_run"
  | "invisible_characters"
  | "hidden_instructions"
  | "confirmed_secret";

export type SecretFinding = { rule: string; kind: string; line: number };

export type FileScan = {
  secrets: SecretFinding[];
  labels: SkillLabel[];
};

type SecretRule = { rule: string; kind: string; pattern: RegExp; check?: (match: RegExpExecArray, line: string) => boolean };

const placeholder = /^(?:x+|\*+|\.+|0+|1234\w*|changeme\w*|example\w*|placeholder|pass(?:word)?\d*|secret\d*|redacted|dummy|test\w*|admin\d*|qwerty\w*|letmein\w*|hunter2|abc123\w*|your[_-]?\w*|<[^>]*>|\$\{?\w+\}?|%\w+%|\{\{[^}]*\}\})$/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

/**
 * A value assigned to a key or password field that looks like the real thing:
 * letters and digits mixed, and not code that reads one (a call, an attribute
 * chain such as process.env.API_KEY, or a template placeholder).
 */
function looksGenerated(value: string): boolean {
  return !placeholder.test(value)
    && !/(?:\.\.\.|\u2026)$/.test(value)
    && /[A-Za-z]/.test(value) && /[0-9]/.test(value)
    && !/[()[\]{}<>]/.test(value)
    && !/example/i.test(value)
    && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+!?$/.test(value);
}

// A line that shows a key or password as what not to do, like `password = "x" // NEVER DO THIS`.
const WARNING_LINE = /\b(?:never|don'?t|do\s+not)\s+do\s+this\b|\u274C|\b(?:bad|wrong|insecure|unsafe)\s+(?:example|practice)\b/i;

const SECRET_RULES: SecretRule[] = [
  { rule: "private_key", kind: "Private key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  // AWS's documentation key ends in EXAMPLE.
  { rule: "aws_access_key", kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    check: (match) => !match[0].endsWith("EXAMPLE") },
  { rule: "github_token", kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { rule: "anthropic_key", kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{30,}/g },
  { rule: "openai_key", kind: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    check: (match) => !match[0].startsWith("sk-ant-") },
  { rule: "stripe_key", kind: "Stripe secret key", pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { rule: "slack_token", kind: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { rule: "google_api_key", kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "npm_token", kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: "jwt", kind: "Signed token (JWT)", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g },
  {
    rule: "credential_in_url",
    kind: "Password in a URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]{6,})@/gi,
    check: (match) => !placeholder.test(match[1]) && !/[${}<>]/.test(match[1])
  },
  {
    rule: "assigned_secret",
    kind: "Key or password",
    pattern: /(?<![A-Za-z])(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.~-]{16,})/gi,
    // Algolia's search keys are public by design: they ship in every site that uses Algolia search.
    check: (match, line) => looksGenerated(match[1]) && entropy(match[1]) >= 3.5 && !WARNING_LINE.test(line) && !/algolia/i.test(line)
  },
  {
    rule: "assigned_password",
    kind: "Password",
    pattern: /(?<![A-Za-z])(?:password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    // A real password mixes letters with digits or symbols; plain words are prose or field names.
    check: (match, line) => looksGenerated(match[1]) && entropy(match[1]) >= 3 && !WARNING_LINE.test(line)
  }
];

const DOWNLOAD_AND_RUN = [
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby)\b/i,
  /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b/i,
  /\b(?:iex|Invoke-Expression)\b[^\n]*(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest|DownloadString)\b/i,
  /\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i
];

// Bidirectional overrides and Unicode tag characters can reorder or hide text from readers, so one is enough.
const INVISIBLE_ALWAYS = /[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;
// Zero-width characters hide text in numbers, or by splitting a word so a check misses it. One or
// two between a letter and a space or symbol are usually stray copy-and-paste.
const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064]|(?<!^)\uFEFF/g;
const ZERO_WIDTH_MIN = 3;

// Letters, digits and the joiners in keys and names: a zero-width character between two of these splits a word or key.
const WORD_CHAR = /^[\p{L}\p{N}_-]$/u;
const ZERO_WIDTH_ONE = /^(?:[\u200B-\u200F\u2060-\u2064]|\uFEFF)$/;

/** The nearest character (a whole emoji, not half of one) from `index` in `step` direction that isn't zero-width, or "". */
function neighbor(text: string, index: number, step: 1 | -1): string {
  while (index >= 0 && index < text.length && ZERO_WIDTH_ONE.test(text[index])) index += step;
  if (index < 0 || index >= text.length) return "";
  const unit = text.charCodeAt(index);
  if (step === -1 && unit >= 0xdc00 && unit <= 0xdfff && index > 0) return String.fromCodePoint(text.codePointAt(index - 1)!);
  return String.fromCodePoint(text.codePointAt(index)!);
}

// A zero-width joiner between emoji builds one emoji (a family, a rainbow flag): that's how emoji are written.
const EMOJI_PART = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F)$/u;

/** Where the first hiding character is, or -1. */
function invisibleAt(text: string): number {
  INVISIBLE_ALWAYS.lastIndex = 0;
  const always = INVISIBLE_ALWAYS.exec(text);
  let index = always ? always.index : -1;
  let count = 0;
  let first = -1;
  ZERO_WIDTH.lastIndex = 0;
  for (let match = ZERO_WIDTH.exec(text); match; match = ZERO_WIDTH.exec(text)) {
    if (match[0] === "\u200D" && EMOJI_PART.test(neighbor(text, match.index - 1, -1)) && EMOJI_PART.test(neighbor(text, match.index + 1, 1))) continue;
    if (first === -1) first = match.index;
    const splitsWord = WORD_CHAR.test(neighbor(text, match.index - 1, -1)) && WORD_CHAR.test(neighbor(text, match.index + match[0].length, 1));
    if (splitsWord) count = ZERO_WIDTH_MIN;
    if (++count >= ZERO_WIDTH_MIN) break;
  }
  if (count >= ZERO_WIDTH_MIN && (index === -1 || first < index)) index = first;
  return index;
}

// "Ignore previous instructions" and "don't let the user know" in other languages. Hiding needs an
// object ("about this", "it") so advice like "don't tell the user to reinstall" doesn't count.
const OTHER_LANGUAGES = [
  /忽略(?:掉)?(?:之前|以前|先前|上面|上述|前面)的?(?:所有|全部|一切)?的?(?:指令|指示|说明|規則|规则|提示)/u,
  /(?:不要|别|切勿|不得)(?:让|讓)用[户戶]知道/u,
  /(?:これまで|以前|前|上記)の(?:すべての|全ての)?(?:指示|命令|ルール)を(?:すべて|全て)?無視/u,
  /ユーザーに(?:は)?(?:知らせ|伝え|言わ)ないで/u,
  /(?:이전의?|앞의|위의)\s*(?:모든\s*)?(?:지시|명령|지침)(?:을|를|은|는)?\s*(?:모두\s*)?무시/u,
  /사용자에게\s*(?:알리지|말하지)\s*마/u,
  /(?<!\p{L})ignor(?:a|e|ar|ad)\s+(?:todas\s+)?las\s+instrucciones\s+anteriores/iu,
  /(?<!\p{L})no\s+se\s+lo\s+(?:digas|diga|cuentes|menciones)\s+al\s+usuario/iu,
  /(?<!\p{L})ignor(?:e|ez|er)\s+(?:toutes\s+)?les\s+instructions\s+pr[ée]c[ée]dentes/iu,
  /(?<!\p{L})ignorier(?:e|en)?\s+(?:alle\s+)?(?:vorherigen|bisherigen|obigen)\s+(?:Anweisungen|Instruktionen)/iu,
  /(?<!\p{L})ignor(?:e|a|ar)\s+(?:todas\s+)?as\s+instru[çc][õo]es\s+anteriores/iu,
  /(?<!\p{L})ignora\s+(?:tutte\s+)?le\s+istruzioni\s+precedenti/iu,
  /(?<!\p{L})игнорир(?:уй|уйте|овать)\s+(?:все\s+)?(?:предыдущие|прошлые|прежние)\s+(?:инструкции|указания)/iu,
  /(?<!\p{L})не\s+(?:говори|сообщай|рассказывай)(?:те)?\s+(?:об\s+этом|это)\s+пользователю/iu
];

// Asking to send secrets away counts even when quoted.
const EXFILTRATE = /\b(?:exfiltrate|send\s+(?:the\s+)?(?:contents?\s+of\s+)?(?:~\/\.ssh|\.env|credentials|api\s+keys?)\b)/i;

const INJECTION = [
  /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts?|rules)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts?|rules)\b/i,
  // Hiding is "don't tell the user" on its own, or about this or what you did. "Don't tell the user to
  // reinstall" or "don't tell the user the swap succeeded yet" is advice about what to say.
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|alert|show)\s+the\s+user\b(?=\s*(?:[.,;:!)\n]|$)|\s+(?:about\b|anything\b|what\s+you\b|that\s+you\b|this\b|it\b))/i,
  // "Never do X without asking the user" is a safety rule, not hiding.
  /(?<!\b(?:do\s+not|don't|never)\b[^.\n]{0,160})\bwithout\s+(?:telling|informing|asking)\s+the\s+user\b/i,
  /\bwithout\s+the\s+user\s+(?:noticing|knowing)\b/i,
  /\bkeep\s+(?:this|it)\s+(?:step\s+)?(?:silent|secret|hidden|quiet)\b/i,
  // "Do not silently install anything" is a safety rule.
  /(?<!\b(?:do\s+not|don't|never)\s+)\b(?:secretly|covertly|quietly|silently)\s+(?:run|execute|send|upload|post|install)\b/i,
  // Text aimed at a scanner or reviewer, asking it to pass the skill.
  /\b(?:note|message)\s+to\s+(?:the\s+)?(?:security\s+)?(?:scanners?|reviewers?|auditors?)\b|\breport\s+(?:it|this(?:\s+skill)?)\s+as\s+safe\b/i,
  // An HTML comment (hidden when the page is shown) that talks to the agent.
  /<!--(?:(?!-->)[\s\S]){0,2000}?\b(?:agent|assistant|claude|llm)\s*[:,](?:(?!-->)[\s\S]){0,2000}?-->/i,
  ...OTHER_LANGUAGES,
  EXFILTRATE
];

const CLOSING_QUOTE: Record<string, string> = { '"': '"', "'": "'", "`": "`", "\u201C": "\u201D", "\u2018": "\u2019" };

/**
 * A phrase quoted on its own, like a skill warning about "ignore previous instructions…", is quoted,
 * not given. Only the phrase may be inside the quotes, so a quoted payload still counts.
 */
function quotedAlone(text: string, index: number, length: number): boolean {
  const close = CLOSING_QUOTE[text[index - 1] ?? ""];
  if (!close) return false;
  const after = /^(?:\u2026|\.{3})?/.exec(text.slice(index + length))![0].length;
  return text[index + length + after] === close;
}

/** Where the first match of any pattern is that `accept` keeps, or -1. */
function firstIndex(text: string, patterns: RegExp[], accept: (match: RegExpExecArray, pattern: RegExp) => boolean = () => true): number {
  let first = -1;
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (let match = global.exec(text); match; match = global.exec(text)) {
      if (first !== -1 && match.index >= first) break;
      if (accept(match, pattern)) {
        first = match.index;
        break;
      }
    }
  }
  return first;
}

function contentLabelIndexes(text: string): [SkillLabel, number][] {
  return [
    ["download_and_run", firstIndex(text, DOWNLOAD_AND_RUN)],
    ["invisible_characters", invisibleAt(text)],
    ["hidden_instructions", firstIndex(text, INJECTION, (match, pattern) => pattern === EXFILTRATE || !quotedAlone(text, match.index, match[0].length))]
  ];
}

const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|psm1|bat|cmd|applescript|scpt|lua|go|rs|swift|jar)$/i;

export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0);
}

function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let position = text.indexOf("\n"); position !== -1 && position < index; position = text.indexOf("\n", position + 1)) {
    line += 1;
  }
  return line;
}

/** Scans one file's contents. Labels that depend on the file's path or mode come from pathLabels. */
export function scanFileContents(data: Uint8Array, options: { text?: boolean } = {}): FileScan {
  if (!options.text && isBinary(data)) return { secrets: [], labels: [] };
  const text = Buffer.from(data).toString("utf8");
  const secrets: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match; match = rule.pattern.exec(text)) {
      if (rule.check && !rule.check(match, lineText(text, match.index))) continue;
      const line = lineAt(text, match.index);
      const key = `${rule.rule}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      secrets.push({ rule: rule.rule, kind: rule.kind, line });
    }
  }
  const labels = contentLabelIndexes(text).filter(([, index]) => index !== -1).map(([label]) => label);
  secrets.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule));
  return { secrets, labels };
}

export function pathLabels(path: string, mode: string): SkillLabel[] {
  return mode === "100755" || SCRIPT_EXTENSIONS.test(path) ? ["scripts"] : [];
}

const LABEL_ORDER: SkillLabel[] = ["confirmed_secret", "download_and_run", "hidden_instructions", "invisible_characters", "scripts"];

export function combineLabels(lists: Iterable<readonly string[]>): SkillLabel[] {
  const all = new Set<string>();
  for (const list of lists) for (const label of list) all.add(label);
  return LABEL_ORDER.filter((label) => all.has(label));
}

/**
 * The first line that set each content label, for showing where a flag came from. Same rules as
 * scanFileContents; binary files have none unless `text` says to read them anyway.
 */
export function labelLines(data: Uint8Array, options: { text?: boolean } = {}): { label: SkillLabel; line: number }[] {
  if (!options.text && isBinary(data)) return [];
  const text = Buffer.from(data).toString("utf8");
  return contentLabelIndexes(text)
    .filter(([, index]) => index !== -1)
    .map(([label, index]) => ({ label, line: lineAt(text, index) }));
}

/** What the background scan also looks for, beyond the labels a saved skill gets. */
export type RiskLabel = "sends_private_data" | "hidden_code";

// Private files and whole environments: keys, cloud logins, the GitHub CLI's token.
const PRIVATE_DATA = /(?:~|\$HOME|\$\{HOME\}|homedir\(\)|expanduser\(\s*['"]~)[^\n]{0,40}?\.(?:ssh|aws|netrc|npmrc|pypirc|docker\/config\.json|kube\/config|config\/gh|gnupg)\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.config\/gh\/hosts\.yml|JSON\.stringify\(\s*process\.env\b|\benv\s*:\s*process\.env\b|(?:dict|str)\(\s*(?:dict\(\s*)?os\.environ\s*\)|\b(?:env|printenv)\s*\|\s*(?:curl|wget|nc)\b|login\.keychain|\bsecurity\s+find-(?:generic|internet)-password\b/i;
// Sending something out: an upload, a POST, a raw socket.
const SENDS = /\bcurl\b[^\n]*(?:\s-d\b|--data|\s-F\b|--form|\s-T\b|--upload-file|-X\s*POST)|\|\s*(?:curl|nc)\b|\bwget\b[^\n]*--post|\bfetch\s*\(|\baxios\.(?:post|put)\b|\brequests\.(?:post|put)\b|\burlopen\s*\(|\bhttps?\.request\s*\(|\bsocket\.(?:connect|send)|\bInvoke-(?:RestMethod|WebRequest)\b[^\n]*-Method\s+Post/i;
/** How close (in lines) reading private data and sending it must be to count. */
const SEND_WINDOW = 5;

// Code that decodes a hidden command and runs it.
const HIDDEN_CODE = [
  /\bbase64\s+(?:-d|-D|--decode)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\b(?:exec|eval)\s*\(\s*(?:base64\.b64decode|codecs\.decode|zlib\.decompress|bytes\.fromhex|marshal\.loads)\b/,
  /\b(?:eval|new\s+Function)\s*\(\s*(?:atob\s*\(|Buffer\.from\([^)\n]*['"](?:base64|hex)['"])/
];
// Compiled programs: what they do can't be read. Python's own cache (__pycache__) is left over from running the scripts beside it.
const COMPILED = /\.(?:pyc|pyo|class|exe|dll|scr|msi)$/i;
const PYTHON_CACHE = /(?:^|\/)__pycache__\/[^/]+\.pyc$/;

function sendsPrivateDataAt(text: string): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (PRIVATE_DATA.test(lines[index])) {
      const near = lines.slice(Math.max(0, index - SEND_WINDOW), index + SEND_WINDOW + 1);
      if (near.some((line) => SENDS.test(line))) return offset;
    }
    offset += lines[index].length + 1;
  }
  return -1;
}

/** The background scan's extra checks: where a file sends private data out, or runs hidden code. */
export function riskLines(path: string, data: Uint8Array, options: { text?: boolean } = {}): { label: RiskLabel; line: number | null }[] {
  const found: { label: RiskLabel; line: number | null }[] = [];
  if (COMPILED.test(path) && !PYTHON_CACHE.test(path)) found.push({ label: "hidden_code", line: null });
  if (!options.text && isBinary(data)) return found;
  const text = Buffer.from(data).toString("utf8");
  const sends = sendsPrivateDataAt(text);
  if (sends !== -1) found.push({ label: "sends_private_data", line: lineAt(text, sends) });
  const hidden = firstIndex(text, HIDDEN_CODE);
  if (hidden !== -1) found.push({ label: "hidden_code", line: lineAt(text, hidden) });
  return found;
}
