import { promises as fs } from "node:fs";
import path from "node:path";
import type { IssueContext, PrContext } from "../../types.js";

export interface LinearClient {
  loadIssue(key: string): Promise<IssueContext>;
}

/** Reads a recorded Linear issue fixture: <dir>/issue.json. */
export class FixtureLinearClient implements LinearClient {
  constructor(private readonly dir: string) {}
  async loadIssue(_key: string): Promise<IssueContext> {
    const raw = await fs.readFile(path.join(this.dir, "issue.json"), "utf8");
    const ctx = JSON.parse(raw) as IssueContext;
    ctx.source = "fixture";
    return ctx;
  }
}

/**
 * Live Linear access through the GraphQL API.
 * Auth: LINEAR_API_KEY in the environment (Linear has no first-class CLI; the issue is
 * otherwise captured into a fixture via the authorized Linear connector). VerifyFlow does
 * not persist the key.
 */
export class LinearApiClient implements LinearClient {
  constructor(private readonly apiKey: string) {}

  async loadIssue(key: string): Promise<IssueContext> {
    const query = `query($id:String!){ issue(id:$id){ identifier title description url state{ name } } }`;
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables: { id: key } }),
    });
    if (!resp.ok) throw new Error(`Linear API ${resp.status}: ${await resp.text()}`);
    const body = (await resp.json()) as {
      data?: { issue?: { identifier: string; title: string; description: string; url: string; state?: { name: string } } };
      errors?: unknown;
    };
    const issue = body.data?.issue;
    if (!issue) throw new Error(`Linear issue ${key} not found (${JSON.stringify(body.errors)})`);
    return {
      key: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url,
      status: issue.state?.name,
      source: "linear-api",
    };
  }
}

/**
 * Extract the linked Linear issue key from a PR body, when present.
 * Symphony PR bodies carry a `## Linear` section with the issue URL. We use this only to
 * RESOLVE which issue to load — never as the acceptance-criteria source (PR is reference only).
 */
export function linearKeyFromPr(pr: PrContext): string | undefined {
  const url = pr.body.match(/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i);
  if (url) return url[1]!.toUpperCase();
  const bare = pr.body.match(/\b([A-Z]{2,}-\d+)\b/);
  return bare ? bare[1]!.toUpperCase() : undefined;
}
