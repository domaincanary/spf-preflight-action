import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { escapeData, type Io, type PreflightAnswer, run } from "../check.ts";

/**
 * check.ts against a fake DomainCanary, one test per verdict and per failure path. The stdout lines
 * are asserted exactly, because the annotations are what a reviewer sees on the pull request.
 */

const BASE: PreflightAnswer = {
  domain: "acme.example",
  verdict: "pass",
  lookups: { published: 3, proposed: 2, limit: 10 },
  all: { published: "~all", proposed: "~all" },
  removed: [],
  added: [],
  traffic: { checked: true, covered_days: 84 },
  findings: [],
  url: "https://domaincanary.com/tools/spf-change-check",
};

function harness(
  answer: { status: number; body: string } | Error,
  env: Record<string, string> = {},
) {
  const lines: string[] = [];
  const files: Record<string, string> = {};
  const comments: Array<{ repo: string; pr: string; body: string }> = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const vars: Record<string, string> = {
    DC_DOMAIN: "acme.example",
    DC_RECORD: "v=spf1 include:mail.example ~all",
    GITHUB_OUTPUT: "/out",
    GITHUB_STEP_SUMMARY: "/summary",
    ...env,
  };
  const io: Io = {
    fetch: ((url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(new Response(answer.body, { status: answer.status }));
    }) as typeof fetch,
    out: (line) => lines.push(line),
    appendFile: (path, text) => {
      files[path] = (files[path] ?? "") + text;
      return Promise.resolve();
    },
    env: (name) => vars[name],
    comment: (repo, pr, body) => {
      comments.push({ repo, pr, body });
      return Promise.resolve();
    },
  };
  return { io, lines, files, comments, requests };
}

function ok(patch: Partial<PreflightAnswer>) {
  return { status: 200, body: JSON.stringify({ ...BASE, ...patch }) };
}

Deno.test("fail: one error line per finding, verdict written, exit 1", async () => {
  const h = harness(ok({
    verdict: "fail",
    removed: [{
      term: "include:esp.example",
      ipv4_addresses: 256,
      ipv6_ranges: 0,
      traffic: { messages: 2300, senders: 1, last_seen: "2026-09-27" },
    }],
    findings: [
      { level: "error", text: "Removing include:esp.example stops 1 sender from passing SPF." },
      { level: "warning", text: "100% of\nthis" },
    ],
  }));
  assertEquals(await run(h.io), 1);
  assertEquals(h.lines, [
    "::error::Removing include:esp.example stops 1 sender from passing SPF.",
    "::warning::100%25 of%0Athis",
  ]);
  assertEquals(h.files["/out"], "verdict=fail\n");
  assertStringIncludes(h.files["/summary"], "| `include:esp.example` | 256 | 0 | 2,300 |");
});

Deno.test("warn: a warning, exit 0, unless fail-on-warn", async () => {
  const answer = ok({ verdict: "warn", findings: [{ level: "warning", text: "Not checked." }] });
  const h = harness(answer);
  assertEquals(await run(h.io), 0);
  assertEquals(h.lines, ["::warning::Not checked."]);
  assertEquals(await run(harness(answer, { DC_FAIL_ON_WARN: "true" }).io), 1);
});

Deno.test("pass and unchanged: a notice, exit 0", async () => {
  for (const verdict of ["pass", "unchanged"] as const) {
    const h = harness(ok({ verdict, findings: [{ level: "notice", text: "Same senders." }] }));
    assertEquals(await run(h.io), 0);
    assertEquals(h.lines, ["::notice::Same senders."]);
    assertEquals(h.files["/out"], `verdict=${verdict}\n`);
  }
});

Deno.test("the key goes in the Authorization header, and only when given", async () => {
  const keyed = harness(ok({}), { DC_API_KEY: "dc_secret" });
  await run(keyed.io);
  const headers = keyed.requests[0].init.headers as Record<string, string>;
  assertEquals(headers.authorization, "Bearer dc_secret");
  assertEquals(keyed.requests[0].url, "https://domaincanary.com/api/v1/spf-preflight");
  const keyless = harness(ok({}));
  await run(keyless.io);
  assertEquals((keyless.requests[0].init.headers as Record<string, string>).authorization, undefined);
});

Deno.test("an error answer or no answer is a red check, never a pass", async () => {
  const limited = harness({ status: 429, body: '{"error":"rate limited; try again in a few minutes"}' });
  assertEquals(await run(limited.io), 1);
  assertEquals(limited.lines, [
    "::error::DomainCanary answered 429: rate limited; try again in a few minutes",
  ]);
  const down = harness(new Error("connection refused"));
  assertEquals(await run(down.io), 1);
  assertEquals(down.lines, ["::error::Could not reach DomainCanary: connection refused"]);
  const empty = harness(ok({}), { DC_RECORD: "" });
  assertEquals(await run(empty.io), 1);
});

Deno.test("comment: posted on a pull request run, a warning elsewhere", async () => {
  const pr = harness(ok({}), {
    DC_COMMENT: "true",
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_REPOSITORY: "acme/dns",
  });
  await run(pr.io);
  assertEquals(pr.comments.length, 1);
  assertEquals(pr.comments[0].pr, "42");
  assertStringIncludes(pr.comments[0].body, "SPF pre-flight for acme.example: pass");
  const push = harness(ok({}), { DC_COMMENT: "true", GITHUB_REF: "refs/heads/main" });
  await run(push.io);
  assertEquals(push.comments, []);
  assertStringIncludes(push.lines.join("\n"), "::warning::comment is true");
});

Deno.test("escapeData escapes the three characters that end a command", () => {
  assertEquals(escapeData("a%b\r\nc"), "a%25b%0D%0Ac");
});
