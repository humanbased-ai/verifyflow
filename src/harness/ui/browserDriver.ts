import path from "node:path";
import type { Evidence } from "../../types.js";

/**
 * Browser execution backend for the ui level (IN-606, PR-2).
 *
 * The browser is an interchangeable backend behind this interface — exactly like the LLM
 * boundary (`LlmClient`). The agentic harness drives a page through `observe()` (what's on
 * screen) and `perform()` (one action) without knowing whether the backend is real Playwright
 * or a scripted fake. Keeping this seam means the agent loop and its verdict guardrails are
 * unit-testable with `FakeBrowserDriver`, with zero browser or network.
 */

export type BrowserActionKind = "navigate" | "click" | "type" | "press" | "wait";

export interface BrowserAction {
  kind: BrowserActionKind;
  /** CSS/text selector for click/type; ignored for navigate/wait/press. */
  selector?: string;
  /** URL for navigate; text for type; key for press; milliseconds (as string) for wait. */
  value?: string;
}

export interface PageObservation {
  url: string;
  title: string;
  /** Truncated, simplified text/structure snapshot the LLM reasons over. */
  domSummary: string;
  /** Path (relative to the run's artifact root) of a screenshot captured at this step. */
  screenshotPath?: string;
  /** Browser console errors seen since the previous observation. */
  consoleErrors: string[];
}

export interface BrowserSession {
  observe(): Promise<PageObservation>;
  /** Execute one action. Returns ok:false (with reason) instead of throwing on a recoverable miss. */
  perform(action: BrowserAction): Promise<{ ok: boolean; error?: string }>;
  /**
   * Flush end-of-session artifacts (e.g. a Playwright trace zip) and return them as evidence.
   * Optional — the fake driver omits it. The harness calls it once, before close().
   */
  finalize?(): Promise<Evidence[]>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Playwright storageState file (cookies/localStorage) for an authenticated session (PR-3). */
  storageStatePath?: string;
  /** Directory where screenshots are written; the harness passes the run's artifact dir. */
  artifactsDir: string;
}

export interface BrowserDriver {
  readonly name: string;
  available(): Promise<boolean>;
  /** Open a page at baseUrl. Throws only on a hard launch/navigation failure (→ blocked). */
  open(baseUrl: string, opts: OpenOptions): Promise<BrowserSession>;
}

const DOM_SUMMARY_LIMIT = 4000;

/**
 * Minimal structural typing for the slice of Playwright we use. Lets us keep `strict` typing
 * without depending on Playwright's type declarations (it's an optional, lazily-imported dep).
 */
interface PwPage {
  on(event: string, cb: (arg: any) => void): void;
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
  screenshot(opts: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  title(): Promise<string>;
  url(): string;
  click(sel: string, opts: Record<string, unknown>): Promise<unknown>;
  fill(sel: string, val: string, opts: Record<string, unknown>): Promise<unknown>;
  keyboard: { press(key: string): Promise<unknown> };
  waitForTimeout(ms: number): Promise<unknown>;
}
interface PwTracing {
  start(opts: Record<string, unknown>): Promise<unknown>;
  stop(opts: Record<string, unknown>): Promise<unknown>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  tracing: PwTracing;
}
interface PwLike {
  chromium: {
    launch(opts: { headless: boolean }): Promise<{
      newContext(opts: Record<string, unknown>): Promise<PwContext>;
      close(): Promise<void>;
    }>;
  };
}

/** Import an optional module by a non-literal specifier so TS doesn't require it to be installed. */
async function optionalImport<T>(name: string): Promise<T> {
  return (await import(name)) as T;
}

/**
 * Playwright-backed driver. Playwright is an optional dependency, lazily imported so the package
 * works (and tests pass) without it; `available()` reports false with install guidance instead of
 * crashing. Install to use: `npm i -D playwright && npx playwright install chromium`.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly name = "playwright-chromium";
  private screenshotSeq = 0;
  private traceSeq = 0;

  async available(): Promise<boolean> {
    try {
      await optionalImport("playwright");
      return true;
    } catch {
      return false;
    }
  }

  async open(baseUrl: string, opts: OpenOptions): Promise<BrowserSession> {
    const { chromium } = await optionalImport<PwLike>("playwright");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(
      opts.storageStatePath ? { storageState: opts.storageStatePath } : {},
    );
    // Record a Playwright trace (screenshots + DOM snapshots + network) for the whole session;
    // finalize() saves it as browser_trace evidence. Best-effort — tracing is optional in older
    // Playwright builds, so a failure here must not break the run.
    let tracing = true;
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
    } catch {
      tracing = false;
    }
    const page = await context.newPage();

    let consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err).slice(0, 300)));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const driver = this;
    return {
      async observe(): Promise<PageObservation> {
        const rel = path.join("ui", `step-${++driver.screenshotSeq}.png`);
        const abs = path.join(opts.artifactsDir, rel);
        try {
          await page.screenshot({ path: abs, fullPage: false });
        } catch {
          /* screenshot is best-effort evidence */
        }
        // A compact, interactive-element-focused snapshot keeps the prompt small and relevant.
        // Runs in the browser context; DOM globals are accessed via `any` so the Node tsconfig
        // (no "dom" lib) stays clean.
        const domSummary: string = await page
          .evaluate((): string => {
            const doc = (globalThis as { document?: any }).document;
            if (!doc) return "";
            const pick = (el: any) => {
              const t = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
              const tag = el.tagName.toLowerCase();
              const attrs = ["id", "name", "type", "placeholder", "aria-label", "role"]
                .map((a: string) => (el.getAttribute(a) ? `${a}="${el.getAttribute(a)}"` : ""))
                .filter(Boolean)
                .join(" ");
              return `<${tag}${attrs ? " " + attrs : ""}>${t}`;
            };
            const nodes = Array.from(
              doc.querySelectorAll("a,button,input,textarea,select,[role],h1,h2,h3,label,[data-testid]"),
            ).slice(0, 120);
            return nodes.map(pick).join("\n");
          })
          .catch(() => "");
        const obs: PageObservation = {
          url: page.url(),
          title: await page.title().catch(() => ""),
          domSummary: domSummary.slice(0, DOM_SUMMARY_LIMIT),
          screenshotPath: rel,
          consoleErrors: consoleErrors.slice(),
        };
        consoleErrors = [];
        return obs;
      },
      async perform(action: BrowserAction) {
        try {
          switch (action.kind) {
            case "navigate":
              await page.goto(action.value ?? baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
              return { ok: true };
            case "click":
              await page.click(action.selector ?? "", { timeout: 8_000 });
              return { ok: true };
            case "type":
              await page.fill(action.selector ?? "", action.value ?? "", { timeout: 8_000 });
              return { ok: true };
            case "press":
              await page.keyboard.press(action.value ?? "Enter");
              return { ok: true };
            case "wait":
              await page.waitForTimeout(Math.min(Number(action.value) || 500, 5_000));
              return { ok: true };
            default:
              return { ok: false, error: `unknown action kind: ${(action as BrowserAction).kind}` };
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
        }
      },
      async finalize(): Promise<Evidence[]> {
        if (!tracing) return [];
        tracing = false; // stop only once
        const rel = path.join("ui", `trace-${++driver.traceSeq}.zip`);
        try {
          await context.tracing.stop({ path: path.join(opts.artifactsDir, rel) });
          return [{ type: "browser_trace", summary: "Playwright session trace (open in `npx playwright show-trace`)", path: rel }];
        } catch {
          return [];
        }
      },
      async close() {
        await browser.close().catch(() => {});
      },
    };
  }
}

/**
 * Deterministic driver for tests and offline orchestration. Replays a scripted list of
 * observations (one per `observe()` call, last repeated) and records every action performed,
 * so the agent loop and verdict guardrails can be exercised without a browser.
 */
export class FakeBrowserDriver implements BrowserDriver {
  readonly name = "browser-fake";
  readonly performed: BrowserAction[] = [];
  readonly opened: { baseUrl: string; opts: OpenOptions }[] = [];
  private obsIndex = 0;

  constructor(
    private readonly script: { observations: PageObservation[]; openError?: string; performError?: string },
  ) {}

  async available(): Promise<boolean> {
    return true;
  }

  async open(baseUrl: string, opts: OpenOptions): Promise<BrowserSession> {
    this.opened.push({ baseUrl, opts });
    if (this.script.openError) throw new Error(this.script.openError);
    const self = this;
    return {
      async observe() {
        const obs = self.script.observations[Math.min(self.obsIndex, self.script.observations.length - 1)];
        self.obsIndex++;
        return obs ?? { url: baseUrl, title: "", domSummary: "", consoleErrors: [] };
      },
      async perform(action: BrowserAction) {
        self.performed.push(action);
        return self.script.performError ? { ok: false, error: self.script.performError } : { ok: true };
      },
      async close() {},
    };
  }
}
