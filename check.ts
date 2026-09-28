/**
 * The action's one step: post the proposed SPF record to DomainCanary and report the verdict to
 * the runner.
 *
 * Everything the runner sees comes from here: one annotation per finding on stdout, the verdict
 * in GITHUB_OUTPUT, a table in the job summary, and the exit code. The annotations are the product,
 * so tests/check_test.ts asserts the exact lines.
 */

export type Verdict = "pass" | "warn" | "fail" | "unchanged";

interface Finding {
  level: "error" | "warning" | "notice";
  text: string;
}

export interface PreflightAnswer {
  domain: string;
  verdict: Verdict;
  lookups: { published: number; proposed: number; limit: number };
  all: { published: string | null; proposed: string | null };
  removed: Array<{
    term: string;
    ipv4_addresses: number;
    ipv6_ranges: number;
    traffic: { messages: number; senders: number; last_seen: string | null } | null;
  }>;
  added: Array<{ term: string }>;
  traffic: { checked: boolean; reason?: string; covered_days?: number };
  findings: Finding[];
  url: string;
}

export interface Inputs {
  domain: string;
  record: string;
  apiKey: string;
  comment: boolean;
  failOnWarn: boolean;
  apiUrl: string;
}

export interface Io {
  fetch: typeof fetch;
  out: (line: string) => void;
  appendFile: (path: string, text: string) => Promise<void>;
  env: (name: string) => string | undefined;
  comment: (repo: string, pr: string, body: string) => Promise<void>;
}

/** Workflow commands end at a newline, so the three characters that break one are escaped. */
export function escapeData(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function inputs(env: (name: string) => string | undefined): Inputs {
  return {
    domain: (env("DC_DOMAIN") ?? "").trim(),
    // A recipe that pipes several TXT values in would send them all. Only the SPF line counts.
    record: (env("DC_RECORD") ?? "").trim(),
    apiKey: (env("DC_API_KEY") ?? "").trim(),
    comment: (env("DC_COMMENT") ?? "false").trim().toLowerCase() === "true",
    failOnWarn: (env("DC_FAIL_ON_WARN") ?? "false").trim().toLowerCase() === "true",
    apiUrl: (env("DC_API_URL") ?? "https://domaincanary.com").replace(/\/+$/, ""),
  };
}

const VERDICTS: readonly string[] = ["pass", "warn", "fail", "unchanged"];
const LEVELS: readonly string[] = ["error", "warning", "notice"];

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2000;
}

/**
 * The answer, checked field by field before any of it reaches the runner, or null.
 *
 * The verdict goes into GITHUB_OUTPUT and each level becomes a workflow command name, so an
 * answer that is not exactly the documented shape is refused rather than printed. A green check
 * depends on this, and the service on the other end of the call is not the runner's to trust.
 */
export function readAnswer(text: string, apiUrl: string): PreflightAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  const lookups = a.lookups as Record<string, unknown> | undefined;
  const all = a.all as Record<string, unknown> | undefined;
  const traffic = a.traffic as Record<string, unknown> | undefined;
  const ending = (v: unknown) => v === null || (isText(v) && /^[+\-~?]?all$/i.test(v));
  if (
    !isText(a.domain) || typeof a.verdict !== "string" || !VERDICTS.includes(a.verdict) ||
    !lookups || !isCount(lookups.published) || !isCount(lookups.proposed) ||
    !isCount(lookups.limit) || !all || !ending(all.published) || !ending(all.proposed) ||
    !traffic || typeof traffic.checked !== "boolean" ||
    !Array.isArray(a.removed) || !Array.isArray(a.added) || !Array.isArray(a.findings)
  ) return null;
  for (const r of a.removed as Record<string, unknown>[]) {
    if (!r || !isText(r.term) || !isCount(r.ipv4_addresses) || !isCount(r.ipv6_ranges)) return null;
    const t = r.traffic as Record<string, unknown> | null;
    if (t !== null && (!t || !isCount(t.messages) || !isCount(t.senders))) return null;
  }
  for (const f of a.findings as Record<string, unknown>[]) {
    if (!f || typeof f.level !== "string" || !LEVELS.includes(f.level) || !isText(f.text)) {
      return null;
    }
  }
  // The link in the summary only ever points at the service that was called.
  const url = isText(a.url) && a.url.startsWith(`${apiUrl}/`) ? a.url : `${apiUrl}/tools/spf-change-check`;
  return { ...(a as unknown as PreflightAnswer), url };
}

/** Text from the answer, made inert in Markdown: no table breaks, links, HTML or code spans. */
export function md(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_[\]<>|!]/g, (c) => `\\${c}`);
}

/** The job summary and the pull request comment: the same short table. */
export function summary(answer: PreflightAnswer): string {
  const lines = [
    `### SPF pre-flight for ${md(answer.domain)}: ${answer.verdict}`,
    "",
    `| | Published | Proposed |`,
    `| --- | --- | --- |`,
    `| DNS lookups (limit ${answer.lookups.limit}) | ${answer.lookups.published} | ${answer.lookups.proposed} |`,
    `| Ending | ${answer.all.published ?? "none"} | ${answer.all.proposed ?? "none"} |`,
    "",
  ];
  if (answer.removed.length > 0) {
    lines.push("| Removed | IPv4 addresses | IPv6 ranges | Messages, last 90 days |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of answer.removed) {
      const traffic = r.traffic === null ? "not checked" : r.traffic.messages.toLocaleString("en-US");
      lines.push(`| ${md(r.term)} | ${r.ipv4_addresses.toLocaleString("en-US")} | ${r.ipv6_ranges} | ${traffic} |`);
    }
    lines.push("");
  }
  for (const f of answer.findings) lines.push(`- **${f.level}**: ${md(f.text)}`);
  lines.push("", `Checked by [DomainCanary](${answer.url}).`);
  return lines.join("\n") + "\n";
}

/** Run the check. Returns the process exit code. */
export async function run(io: Io): Promise<number> {
  const given = inputs(io.env);
  if (!given.domain || !given.record) {
    io.out("::error::The domain and record inputs are both required.");
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (given.apiKey) headers.authorization = `Bearer ${given.apiKey}`;

  let res: Response;
  try {
    res = await io.fetch(`${given.apiUrl}/api/v1/spf-preflight`, {
      method: "POST",
      headers,
      body: JSON.stringify({ domain: given.domain, record: given.record }),
    });
  } catch (e) {
    io.out(`::error::Could not reach DomainCanary: ${escapeData((e as Error).message)}`);
    return 1;
  }
  const text = await res.text();
  if (res.status !== 200) {
    let error = text.slice(0, 300);
    try {
      error = JSON.parse(text).error ?? error;
    } catch { /* the raw body is the best we have */ }
    // Not a verdict, so never a green check: a rerun is the fix for a 429 or a 503, and a 401
    // means the secret needs replacing.
    io.out(`::error::DomainCanary answered ${res.status}: ${escapeData(String(error))}`);
    return 1;
  }
  const answer = readAnswer(text, given.apiUrl);
  if (answer === null) {
    io.out("::error::DomainCanary answered with something that is not a verdict.");
    return 1;
  }

  for (const f of answer.findings) io.out(`::${f.level}::${escapeData(f.text)}`);

  const output = io.env("GITHUB_OUTPUT");
  if (output) await io.appendFile(output, `verdict=${answer.verdict}\n`);
  const table = summary(answer);
  const step = io.env("GITHUB_STEP_SUMMARY");
  if (step) await io.appendFile(step, table);

  if (given.comment) {
    const pr = /^refs\/pull\/(\d+)\//.exec(io.env("GITHUB_REF") ?? "")?.[1];
    const repo = io.env("GITHUB_REPOSITORY");
    if (pr && repo) {
      try {
        await io.comment(repo, pr, table);
      } catch (e) {
        io.out(`::warning::Could not post the pull request comment: ${escapeData((e as Error).message)}`);
      }
    } else {
      io.out("::warning::comment is true, but this run is not for a pull request, so no comment was posted.");
    }
  }

  if (answer.verdict === "fail") return 1;
  if (answer.verdict === "warn" && given.failOnWarn) return 1;
  return 0;
}

if (import.meta.main) {
  const code = await run({
    fetch,
    out: (line) => console.log(line),
    appendFile: (path, text) => Deno.writeTextFile(path, text, { append: true }),
    env: (name) => Deno.env.get(name),
    comment: async (repo, pr, body) => {
      const child = new Deno.Command("gh", {
        args: ["pr", "comment", pr, "--repo", repo, "--body-file", "-"],
        stdin: "piped",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(body));
      await writer.close();
      const status = await child.output();
      if (!status.success) throw new Error(new TextDecoder().decode(status.stderr).trim());
    },
  });
  Deno.exit(code);
}
