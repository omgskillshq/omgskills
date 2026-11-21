// After a deploy: asks the live scanner, with a signed request, whether its container can reach
// the internet, and which scanners it runs. Fails the deploy if the internet is reachable.
import { signRequest } from "../src/signature.js";

const url = process.env.SCAN_WORKER_URL?.replace(/\/+$/, "");
const key = process.env.SCAN_SIGNING_KEY;
if (!url || !key) throw new Error("SCAN_WORKER_URL and SCAN_SIGNING_KEY are required");

// A deploy that changes the container can take several minutes to swap the old one out, and the
// scanner answers 5xx (or not at all) until then. Keep asking for up to 10 minutes; a 401 or other
// 4xx means a wrong key or URL, so fail at once.
const WAIT_MS = 10 * 60_000;
const RETRY_MS = 15_000;

async function get(path: string): Promise<unknown> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const headers = await signRequest(key!, "GET", path, new Uint8Array());
    let response: Response | undefined;
    let problem: string;
    try {
      response = await fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(60_000) });
      problem = `answered ${response.status}`;
    } catch (error) {
      problem = `did not answer (${error instanceof Error ? error.message : String(error)})`;
    }
    if (response?.ok) return response.json();
    if (response && response.status < 500) throw new Error(`${path} ${problem}`);
    if (Date.now() + RETRY_MS > deadline) throw new Error(`${path} ${problem} for 10 minutes`);
    console.log(`${path} ${problem}; the new container may still be starting. Trying again.`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

const { internet } = await get("/selftest") as { internet: boolean };
if (internet !== false) throw new Error("The scanner container can reach the internet; it must not.");
const { scanners } = await get("/scanners") as { scanners: { scanner: string; version: string }[] };
if (!Array.isArray(scanners) || scanners.length === 0) throw new Error("The scanner lists no scanners.");
console.log(`No internet in the container. Scanners: ${scanners.map((s) => `${s.scanner} ${s.version}`).join(", ")}`);
