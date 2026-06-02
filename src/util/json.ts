/**
 * Extract the first JSON value (object or array) from arbitrary model text,
 * tolerating ```json fences and surrounding prose.
 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;

  // Try the whole candidate first.
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // fall through to bracket scan
  }

  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("no JSON value found in model output");

  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        return JSON.parse(slice) as T;
      }
    }
  }
  throw new Error("unterminated JSON value in model output");
}
