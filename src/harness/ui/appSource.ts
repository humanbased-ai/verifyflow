import { run } from "../../util/exec.js";
import type { PrContext } from "../../types.js";
import type { RepoConfig } from "../../core/planner/repoConfig.js";

/**
 * App-source resolution for the ui level (IN-606, PR-1).
 *
 * Browser-backed verification needs a *live* app to drive. VerifyFlow does not own that app, so
 * it resolves a base URL through a three-tier fallback, preferring the cheapest/most-trustworthy
 * source first and never guessing:
 *
 *   1. explicit  — an operator/orchestrator-supplied `--base-url`. Always wins.
 *   2. preview   — a deployment preview URL discovered from the PR's GitHub commit statuses
 *                  (Vercel/Netlify/etc. post these). Closest to production, zero build cost.
 *   3. local     — build & serve the checked-out PR ourselves, inferred from the repo config.
 *                  Heaviest and least general; only used when a serve plan is known AND a server
 *                  starter is wired.
 *
 * When no tier yields a URL the result is `blocked` (never a fake URL) so the verdict engine
 * environment-blocks the ui criteria rather than silently passing or failing them — the same
 * "fail loud, never false pass" contract used by repoConfig (IN-551) and UnavailableUiHarness.
 *
 * This module is the deterministic decision core. Live I/O (gh, spawning a server) is injected
 * so the resolution logic and the URL/plan parsers are unit-testable without a network or a
 * running server.
 */

export type AppSource = "explicit" | "preview" | "local-serve";

export type AppSourceResult =
  | {
      kind: "ready";
      baseUrl: string;
      source: AppSource;
      /** Tear down a server this resolver started (local-serve only); no-op otherwise. */
      cleanup: () => Promise<void>;
    }
  | { kind: "blocked"; reason: string };

/** A GitHub commit/deployment status, as surfaced by `gh api`. Only the fields we read. */
export interface DeploymentStatus {
  /** "success" | "pending" | "failure" | "error" | "in_progress" | "queued" | … */
  state: string;
  /** The deployed URL (Vercel/Netlify put the preview here). */
  targetUrl?: string;
  /** Integration/context label, e.g. "vercel", "netlify", "Vercel – my-app". */
  context?: string;
  /** Optional creation timestamp; newer wins when several previews succeed. */
  createdAt?: string;
}

/** A plan to build & serve the PR locally: the command to run and where the app will listen. */
export interface LocalServePlan {
  /** Shell command that starts a long-running dev/preview server. */
  command: string;
  /** Base URL the started server is expected to listen on. */
  baseUrl: string;
}

export interface AppSourceDeps {
  /** Discover deployment previews for the PR head. Absent → the preview tier is skipped. */
  lookupDeployments?: (pr: PrContext) => Promise<DeploymentStatus[]>;
  /**
   * Start a local server from a plan and return its live URL + cleanup. Absent → the local tier
   * is skipped (PR-1 ships the plan inference; the starter is wired in a follow-up).
   */
  startServer?: (plan: LocalServePlan, workdir: string) => Promise<{ baseUrl: string; cleanup: () => Promise<void> }>;
}

const NOOP_CLEANUP = async () => {};

/** Host fragments that mark a status target as a deploy preview rather than a dashboard link. */
const PREVIEW_HOST = /(vercel\.app|netlify\.app|netlify\.com|pages\.dev|onrender\.com|fly\.dev|herokuapp\.com|ngrok|surge\.sh)/i;
/** Integration contexts known to publish preview deployments. */
const PREVIEW_CONTEXT = /(vercel|netlify|render|cloudflare|deploy|preview)/i;

/**
 * Pick the best preview URL from a PR's commit statuses. A candidate must be in a successful
 * state and look like a deployment (preview host, or a preview-ish context with an http URL).
 * Among candidates, prefer a recognized preview host, then the most recently created.
 */
export function extractPreviewUrl(statuses: DeploymentStatus[]): string | undefined {
  const candidates = statuses.filter((s) => {
    if (s.state !== "success") return false;
    const url = s.targetUrl?.trim();
    if (!url || !/^https?:\/\//i.test(url)) return false;
    return PREVIEW_HOST.test(url) || PREVIEW_CONTEXT.test(s.context ?? "");
  });
  if (candidates.length === 0) return undefined;

  const score = (s: DeploymentStatus) => (PREVIEW_HOST.test(s.targetUrl ?? "") ? 1 : 0);
  candidates.sort((a, b) => {
    const byHost = score(b) - score(a);
    if (byHost !== 0) return byHost;
    // Newer first when both (or neither) are recognized hosts.
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
  return candidates[0]!.targetUrl!.trim().replace(/\/+$/, "");
}

/**
 * Infer how to build & serve a repo locally for browser checks. Returns undefined when the
 * ecosystem has no known dev-server convention — the caller then blocks rather than guessing.
 * Node is the only ecosystem with a portable convention today; others are deliberately omitted
 * until their serve story is real.
 */
export function inferServePlan(cfg: RepoConfig, port = 4173): LocalServePlan | undefined {
  if (cfg.unknown) return undefined;
  if (cfg.source.startsWith("inferred-node") || cfg.source === "file") {
    const pm = cfg.source.includes("pnpm") ? "pnpm" : cfg.source.includes("yarn") ? "yarn" : "npm";
    // `preview` serves a production build (stable); fall back to `dev`. Pin the port so the
    // resolved baseUrl matches what the server actually binds.
    const runScript = pm === "npm" ? "npm run" : `${pm} run`;
    return {
      command: `${runScript} preview -- --port ${port} || ${runScript} dev -- --port ${port}`,
      baseUrl: `http://localhost:${port}`,
    };
  }
  return undefined;
}

/**
 * Resolve a base URL for ui-level browser checks, trying explicit → preview → local-serve.
 * Pure decision logic over injected I/O; returns `blocked` (with what was tried) when no tier
 * produces a URL.
 */
export async function resolveAppSource(opts: {
  explicitBaseUrl?: string;
  pr: PrContext;
  repoConfig: RepoConfig;
  workdir?: string;
  deps?: AppSourceDeps;
}): Promise<AppSourceResult> {
  const { explicitBaseUrl, pr, repoConfig, workdir, deps = {} } = opts;
  const tried: string[] = [];

  // Tier 1 — explicit base URL.
  if (explicitBaseUrl && explicitBaseUrl.trim()) {
    return { kind: "ready", baseUrl: explicitBaseUrl.trim().replace(/\/+$/, ""), source: "explicit", cleanup: NOOP_CLEANUP };
  }
  tried.push("no --base-url provided");

  // Tier 2 — preview deployment discovery.
  if (deps.lookupDeployments) {
    try {
      const statuses = await deps.lookupDeployments(pr);
      const url = extractPreviewUrl(statuses);
      if (url) return { kind: "ready", baseUrl: url, source: "preview", cleanup: NOOP_CLEANUP };
      tried.push(`no successful preview deployment among ${statuses.length} status(es)`);
    } catch (err) {
      tried.push(`preview lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    tried.push("preview discovery not enabled");
  }

  // Tier 3 — build & serve the PR locally.
  const plan = inferServePlan(repoConfig);
  if (!plan) {
    tried.push(`no local serve plan for repo (source: ${repoConfig.source})`);
  } else if (!deps.startServer) {
    tried.push("local serve plan available but server starter not wired");
  } else {
    try {
      const { baseUrl, cleanup } = await deps.startServer(plan, workdir ?? process.cwd());
      return { kind: "ready", baseUrl: baseUrl.replace(/\/+$/, ""), source: "local-serve", cleanup };
    } catch (err) {
      tried.push(`local serve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { kind: "blocked", reason: `could not resolve a live app URL for ui checks (${tried.join("; ")})` };
}

/**
 * `gh`-backed deployment lookup: reads the combined commit statuses for the PR head SHA.
 * Thin live adapter — the parsing it feeds (`extractPreviewUrl`) is what carries the tests.
 */
export function ghDeploymentLookup(): (pr: PrContext) => Promise<DeploymentStatus[]> {
  return async (pr: PrContext) => {
    const res = await run("gh", [
      "api",
      `repos/${pr.repo}/commits/${pr.headSha}/statuses`,
      "--paginate",
    ]);
    if (!res.executed || res.code !== 0) {
      throw new Error(res.spawnError ?? `gh api statuses failed: ${res.stderr.slice(0, 200)}`);
    }
    const raw = JSON.parse(res.stdout || "[]") as {
      state: string; target_url?: string; context?: string; created_at?: string;
    }[];
    return raw.map((s) => ({
      state: s.state,
      targetUrl: s.target_url,
      context: s.context,
      createdAt: s.created_at,
    }));
  };
}