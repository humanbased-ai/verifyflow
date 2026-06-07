import type {
  Criterion,
  CriteriaModel,
  CriterionMethod,
  IssueContext,
  PrContext,
  Probe,
} from "../../types.js";
import type { LlmClient } from "../../backends/llm.js";
import { extractJson } from "../../util/json.js";

/**
 * Turns the Linear issue into testable criteria.
 *
 * Source-of-truth rule (boss directive): the Linear issue is PRIMARY. The PR body/diff is
 * REFERENCE ONLY — it is given to the model as context but is never the criteria source.
 *
 * Pipeline:
 *   1. Deterministically extract the issue's "Acceptance Criteria" bullets, quoting exact text.
 *   2. Derive a runnable probe heuristically from each bullet (inline code + expected output).
 *   3. If an LLM backend is available, enrich: classify method, refine/validate probes, flag
 *      unobservable criteria, and surface implicit expectations — explicitly forbidden from
 *      inventing criteria the ticket does not support.
 */
export async function parseCriteria(
  issue: IssueContext,
  pr: PrContext,
  llm: LlmClient,
): Promise<CriteriaModel> {
  const base = extractExplicitCriteria(issue);
  const ticketQualityIssues: string[] = [];
  if (base.length === 0) {
    ticketQualityIssues.push(
      "No explicit acceptance criteria found in the Linear issue; criteria inferred from summary.",
    );
  }

  let criteria = base.length > 0 ? base : inferFromSummary(issue);
  for (const c of criteria) if (!c.probe) c.probe = heuristicProbe(c.text);

  if (await llm.available()) {
    try {
      criteria = await enrichWithLlm(criteria, issue, pr, llm, ticketQualityIssues);
    } catch (err) {
      ticketQualityIssues.push(
        `LLM enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { criteria, ticketQualityIssues };
}

/** Headings that introduce an acceptance-criteria / requirements section (IN-558). */
const CRITERIA_HEADING = /^#{1,6}\s*(acceptance\s+criteria|acceptance\s+tests|requirements?)\b/i;
const BULLET = /^(?:[-*•]|\d+[.)])\s+(.*)$/;
/** Normative cues that mark a sentence as a testable requirement, not prose. */
const NORMATIVE = /\b(must|should|shall|prints?|returns?|exits?|displays?|outputs?|supports?|accepts?|rejects?|emits?|raises?)\b/i;

function criterion(text: string, index: number): Criterion {
  return { id: `AC-${index + 1}`, text, source: "linear_explicit", method: "backend", observable: true };
}

/**
 * Extract explicit, ticket-quoted criteria.
 *
 * Primary path: a recognized criteria/requirements heading → its bullet/numbered items
 * (verbatim). Fallback (IN-558): when no such heading exists, recover testable requirements
 * from the body — bullets that carry a normative cue or an inline-code command, plus
 * must/should/shall sentences — so requirements stated as numbered feature points or prose are
 * not silently dropped when the LLM is unavailable.
 */
export function extractExplicitCriteria(issue: IssueContext): Criterion[] {
  const lines = issue.description.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => CRITERIA_HEADING.test(l.trim()));

  if (headingIdx !== -1) {
    const out: Criterion[] = [];
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (/^#{1,6}\s/.test(line)) break; // next heading ends the section
      const m = line.match(BULLET);
      if (m && m[1]!.trim().length > 0) out.push(criterion(m[1]!.trim(), out.length));
    }
    return out;
  }

  return extractNormative(lines);
}

/** Fallback extractor for tickets with no explicit acceptance-criteria heading. */
function extractNormative(lines: string[]): Criterion[] {
  const out: Criterion[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue; // skip blanks and headings
    const bullet = line.match(BULLET);
    const text = (bullet ? bullet[1]! : line).trim();
    if (text.length < 8) continue;
    const hasCode = /`[^`]+`/.test(text);
    const normative = NORMATIVE.test(text);
    // Bullets count when they look testable (cue or command); plain prose only with a strong cue.
    const keep = bullet ? normative || hasCode : normative;
    if (keep) out.push(criterion(text, out.length));
    if (out.length >= 12) break;
  }
  return out;
}

function inferFromSummary(issue: IssueContext): Criterion[] {
  const summary = issue.description.split(/\r?\n/).find((l) => l.trim().length > 0);
  return [
    {
      id: "AC-1",
      text: summary?.trim() || issue.title,
      source: "linear_implicit",
      method: "backend",
      observable: Boolean(summary),
    },
  ];
}

/**
 * Heuristically build a probe from criterion text: an inline-code shell command plus an
 * expected output substring (quoted code) and an exit-code expectation if mentioned.
 */
export function heuristicProbe(text: string): Probe | undefined {
  const codes = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const command = codes.find((c) => looksLikeShellCommand(c));
  if (!command) return undefined;

  // The first quoted non-command token is treated as expected output (e.g. `Symphony 0.1.0`).
  const expectSubstring = codes
    .filter((c) => c !== command && !looksLikeShellCommand(c))
    .map((c) => c.replace(/<[^>]+>/g, "").trim()) // drop placeholders like <version>
    .find((c) => c.length > 0);

  const expectExitCode = /\bexits?\s+(?:with\s+)?(?:code\s+)?0\b|\bexit\s+0\b/i.test(text)
    ? 0
    : undefined;

  return { command, expectSubstring, expectExitCode, fromTicket: true };
}

/** Coerce a model-supplied ticket-quality issue (string or object) into clean human text. */
function normalizeQualityIssue(q: unknown): string[] {
  if (typeof q === "string") return q.trim() ? [q.trim()] : [];
  if (q && typeof q === "object") {
    const o = q as Record<string, unknown>;
    const label = typeof o.criterion === "string" ? o.criterion : undefined;
    const body = [o.issue, o.text, o.message, o.note, o.problem].find(
      (v) => typeof v === "string",
    ) as string | undefined;
    if (body) return [label ? `${label}: ${body}` : body];
    return [JSON.stringify(q)];
  }
  return [];
}

/** Adopt only the safe fields of a model-proposed probe (never its cwd; never authoritative). */
function sanitizeProbe(p: Probe): Probe {
  return {
    command: p.command,
    expectSubstring: p.expectSubstring,
    expectExitCode: p.expectExitCode,
  };
}

const SHELL_HINTS = ["sy", "vf", "verifyflow", "npm", "pnpm", "yarn", "uv", "pytest", "python", "node", "go", "cargo", "make", "curl", "git"];
function looksLikeShellCommand(s: string): boolean {
  if (s.includes("\n")) return false;
  const first = s.trim().split(/\s+/)[0] ?? "";
  if (SHELL_HINTS.includes(first)) return true;
  return /\s--?\w/.test(s); // contains a flag like --version / -v
}

interface LlmCriterion {
  id: string;
  method?: CriterionMethod;
  observable?: boolean;
  probe?: Probe | null;
  notes?: string;
}
interface LlmEnrichResponse {
  criteria?: LlmCriterion[];
  implicit?: { text: string; method?: CriterionMethod; probe?: Probe | null; notes?: string }[];
  ticketQualityIssues?: unknown[];
}

async function enrichWithLlm(
  criteria: Criterion[],
  issue: IssueContext,
  pr: PrContext,
  llm: LlmClient,
  ticketQualityIssues: string[],
): Promise<Criterion[]> {
  const system =
    "You are VerifyFlow's acceptance-criteria analyst. The Linear issue is the ONLY source of " +
    "truth for acceptance criteria. The pull request is REFERENCE CONTEXT ONLY — never treat PR " +
    "text as a criterion. Do not invent criteria the issue does not support. Reply with JSON only.";

  const prompt = [
    "## Linear issue (SOURCE OF TRUTH)",
    `Key: ${issue.key}\nTitle: ${issue.title}`,
    "Description:",
    issue.description,
    "",
    "## Pull request (REFERENCE ONLY — what was changed/claimed)",
    `${pr.repo}#${pr.number}: ${pr.title}`,
    `Changed files: ${pr.changedFiles.map((f) => f.path).join(", ")}`,
    "",
    "## Already-extracted explicit criteria (keep their text verbatim; refine metadata only)",
    JSON.stringify(criteria.map((c) => ({ id: c.id, text: c.text })), null, 2),
    "",
    "## Task",
    "For each criterion, return: method (backend|ui|integration|journey), observable (boolean — " +
      "false if too vague/contradictory/unobservable), and probe (a directly runnable shell check " +
      "{command, expectSubstring?, expectExitCode?, cwd?} or null if not runnable). You MAY add " +
      "issue-supported implicit criteria under `implicit`. Also list ticketQualityIssues for any " +
      "vague/missing/contradictory criteria.",
    "Respond with JSON: {criteria:[{id,method,observable,probe,notes}], implicit:[{text,method,probe,notes}], ticketQualityIssues:[]}",
  ].join("\n");

  const raw = await llm.complete({ system, prompt, task: "criteria-enrich", tier: "fast" });
  const parsed = extractJson<LlmEnrichResponse>(raw);

  const byId = new Map(criteria.map((c) => [c.id, c]));
  for (const lc of parsed.criteria ?? []) {
    const c = byId.get(lc.id);
    if (!c) continue;
    if (lc.method) c.method = lc.method;
    // A criterion with a ticket-derived runnable probe is observable by definition; the
    // model may only mark a criterion unobservable when there is no deterministic probe.
    if (typeof lc.observable === "boolean" && !c.probe) c.observable = lc.observable;
    // Never overwrite the deterministic, ticket-quoted probe; only fill a missing one,
    // and drop any model-supplied cwd (a common source of bad, non-existent paths).
    if (!c.probe && lc.probe?.command) c.probe = sanitizeProbe(lc.probe);
    if (lc.notes) c.notes = lc.notes;
  }

  const merged = [...criteria];
  let n = merged.length;
  for (const im of parsed.implicit ?? []) {
    if (!im.text?.trim()) continue;
    merged.push({
      id: `AC-${++n}`,
      text: im.text.trim(),
      source: "linear_implicit",
      method: im.method ?? "backend",
      observable: true,
      probe: im.probe?.command ? sanitizeProbe(im.probe) : heuristicProbe(im.text),
      notes: im.notes,
    });
  }
  for (const q of parsed.ticketQualityIssues ?? []) {
    ticketQualityIssues.push(...normalizeQualityIssue(q));
  }
  return merged;
}
