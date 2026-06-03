import { promises as fs } from "node:fs";
import path from "node:path";
import type { IssueContext, PrContext } from "../../types.js";

export interface LinearClient {
  loadIssue(key: string): Promise<IssueContext>;
  /** Optional write-back (IN-560): post a comment on the issue. Present only on the live client. */
  addComment?(issueKey: string, body: string): Promise<boolean>;
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

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) throw new Error(`Linear API ${resp.status}: ${await resp.text()}`);
    const body = (await resp.json()) as { data?: T; errors?: unknown };
    if (!body.data) throw new Error(`Linear API error: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  async loadIssue(key: string): Promise<IssueContext> {
    const query = `query($id:String!){ issue(id:$id){ id identifier title description url state{ name } } }`;
    const data = await this.graphql<{
      issue?: { id: string; identifier: string; title: string; description: string; url: string; state?: { name: string } };
    }>(query, { id: key });
    const issue = data.issue;
    if (!issue) throw new Error(`Linear issue ${key} not found`);
    return {
      key: issue.identifier,
      id: issue.id,
      title: issue.title,
      description: issue.description ?? "",
      url: issue.url,
      status: issue.state?.name,
      source: "linear-api",
    };
  }

  /** Post a comment on the issue (write-back). Resolves the UUID first, then commentCreate. */
  async addComment(issueKey: string, body: string): Promise<boolean> {
    try {
      const data = await this.graphql<{ issue?: { id: string } }>(
        `query($id:String!){ issue(id:$id){ id } }`,
        { id: issueKey },
      );
      const uuid = data.issue?.id;
      if (!uuid) return false;
      const res = await this.graphql<{ commentCreate?: { success: boolean } }>(
        `mutation($issueId:String!,$body:String!){ commentCreate(input:{issueId:$issueId,body:$body}){ success } }`,
        { issueId: uuid, body },
      );
      return res.commentCreate?.success === true;
    } catch {
      return false;
    }
  }
}

/**
 * Extract the linked Linear issue key from a PR, when present.
 * Symphony PR bodies carry a `## Linear` section with the issue URL; Symphony/Linear branches
 * embed the key (`haol/in-569-...`). Body wins (explicit link), branch name is the fallback.
 * We use this only to RESOLVE which issue to load — never as the acceptance-criteria source
 * (PR is reference only).
 */
export function linearKeyFromPr(pr: PrContext): string | undefined {
  const url = pr.body.match(/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i);
  if (url) return url[1]!.toUpperCase();
  const bare = pr.body.match(/\b([A-Z]{2,}-\d+)\b/);
  if (bare) return bare[1]!.toUpperCase();
  // Linear's generated branch format: <user>/<team>-<number>-<slug> (e.g. haol/in-569-step-adapter).
  const branch = pr.headRef.match(/(?:^|\/)([A-Za-z]{2,})-(\d+)(?:-|$)/);
  return branch ? `${branch[1]!.toUpperCase()}-${branch[2]}` : undefined;
}
