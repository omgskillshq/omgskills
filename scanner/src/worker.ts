import { Container, getContainer } from "@cloudflare/containers";
import Anthropic from "@anthropic-ai/sdk";
import { AI_REVIEW_TIMEOUT_MS, aiReview, type AskClaude } from "./ai-review.js";
import { handle } from "./handler.js";

/** The scanner: files in, findings out. No internet, no keys, never runs skill code. */
export class Scanner extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = false;
}

type Env = {
  SCANNER: DurableObjectNamespace<Scanner>;
  CLOUD_FILES: R2Bucket;
  SCAN_SIGNING_KEY: string;
  /** For the AI review of public skills; without it, scans that ask for one get a 503. */
  ANTHROPIC_API_KEY?: string;
};

/**
 * One scanner, always the same one: the scanner-list call at the start of a run wakes it, so the
 * scans right after don't wait for another copy to start.
 */
const INSTANCE = "scanner";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      signingKey: env.SCAN_SIGNING_KEY,
      async readStoredFile(key) {
        const object = await env.CLOUD_FILES.get(key);
        return object ? new Uint8Array(await object.arrayBuffer()) : null;
      },
      aiReview: env.ANTHROPIC_API_KEY
        ? (files) => {
          // One try, well inside the caller's wait; the queue retries later rather than paying for answers it dropped.
          const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: AI_REVIEW_TIMEOUT_MS, maxRetries: 0 });
          const ask: AskClaude = (request) => client.messages.create(request);
          return aiReview(files, ask);
        }
        : undefined,
      async container(path, init) {
        const stub = getContainer(env.SCANNER, INSTANCE);
        return stub.fetch(new Request(`http://scanner${path}`, { method: init?.method ?? "GET", body: init?.body }));
      }
    });
  }
};
