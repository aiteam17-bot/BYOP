#!/usr/bin/env node
// Secret scan for this repository. Prints REDACTED findings only: a match is
// shown as its first 4 characters, "…", and its length. Values are never
// printed or written anywhere.
//
//   node scripts/scan-secrets.mjs            scan this repo (tracked files,
//                                            untracked files, full git history)
//   node scripts/scan-secrets.mjs <folder>   scan a folder that is not a git repo
//
// Exit code 1 if anything that looks like a real secret is found in a place
// git would publish (tracked files or history).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const RULES = [
  { id: "supabase-secret-key", severity: "secret", re: /sb_secret_[A-Za-z0-9_-]{10,}/g },
  { id: "supabase-publishable-key", severity: "public", re: /sb_publishable_[A-Za-z0-9_-]{10,}/g },
  { id: "jwt", severity: "check", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "github-token", severity: "secret", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { id: "aws-access-key", severity: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "private-key", severity: "secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "postgres-url-with-password", severity: "secret", re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@[^\s'"]+/g },
  // 40 hex characters (e.g. an OAuth client secret) only next to a secret-ish word.
  { id: "hex40-near-secret-word", severity: "secret", re: /(?:secret|client|token|key)[^\n]{0,40}?\b([0-9a-f]{40})\b/gi, group: 1 },
  {
    id: "hardcoded-credential",
    severity: "secret",
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    group: 1,
  },
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage", ".vercel"]);
const SKIP_FILES = new Set(["package-lock.json"]);

function redact(value) {
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : "unknown";
  } catch {
    return "unreadable";
  }
}

function scanText(text, where, findings) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const value = rule.group ? m[rule.group] : m[0];
        if (!value) continue;
        // Placeholders in docs and examples are not secrets.
        if (/your[-_]|example|placeholder|xxxx|<|\$\{/i.test(value)) continue;
        let severity = rule.severity;
        let note = "";
        if (rule.id === "jwt") {
          const role = jwtRole(value);
          note = `role=${role}`;
          severity = role === "anon" || role === "authenticated" ? "public" : "secret";
        }
        findings.push({ where: `${where}:${i + 1}`, rule: rule.id, severity, value: redact(value), note });
      }
    }
  });
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (st.size < 2_000_000 && !SKIP_FILES.has(name)) out.push(relative(root, full));
  }
  return out;
}

const target = process.argv[2] ?? process.cwd();
const isGit = existsSync(join(target, ".git"));
const sections = [];

if (isGit) {
  const tracked = git(["ls-files"], target).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], target).split("\n").filter(Boolean);
  const ignoredEnv = git(["ls-files", "--others", "--ignored", "--exclude-standard"], target)
    .split("\n")
    .filter((f) => /(^|\/)\.env/.test(f) && !f.includes("node_modules"));

  for (const [label, files] of [["tracked files", tracked], ["untracked, not ignored", untracked]]) {
    const findings = [];
    for (const f of files) {
      if (SKIP_FILES.has(f.split("/").pop())) continue;
      try {
        scanText(readFileSync(join(target, f), "utf8"), f, findings);
      } catch {
        /* binary or unreadable */
      }
    }
    sections.push({ label: `${label} (${files.length})`, findings, publishes: true });
  }

  // Every added line in every commit on every branch.
  const history = git(["log", "-p", "--all", "--no-color", "--format=commit %h"], target);
  const findings = [];
  let commit = "";
  let file = "";
  let commits = 0;
  for (const line of history.split("\n")) {
    if (line.startsWith("commit ")) { commit = line.slice(7); commits += 1; continue; }
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (line.startsWith("+") && !line.startsWith("+++") && !SKIP_FILES.has(file.split("/").pop())) {
      scanText(line.slice(1), `${commit} ${file}`, findings);
    }
  }
  sections.push({ label: `git history (${commits} commits, all branches)`, findings, publishes: true });

  // Local env files: must be ignored and untracked. Report names only.
  const envFindings = [];
  for (const f of ignoredEnv) {
    const names = readFileSync(join(target, f), "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1])
      .filter(Boolean);
    const inner = [];
    scanText(readFileSync(join(target, f), "utf8"), f, inner);
    envFindings.push({
      where: f,
      rule: "ignored-env-file",
      severity: inner.some((x) => x.severity === "secret") ? "secret-local" : "info",
      value: `variables: ${names.join(", ") || "(none)"}`,
      note: inner.map((x) => `${x.rule} ${x.value}${x.note ? " " + x.note : ""}`).join("; "),
    });
  }
  sections.push({ label: `git-ignored env files (${ignoredEnv.length})`, findings: envFindings, publishes: false });
} else {
  const files = walk(target, target, []);
  const findings = [];
  for (const f of files) {
    try {
      scanText(readFileSync(join(target, f), "utf8"), f, findings);
    } catch {
      /* binary */
    }
  }
  sections.push({ label: `files (${files.length}, not a git repo)`, findings, publishes: true });
}

let blocking = 0;
console.log(`Secret scan: ${target}`);
for (const s of sections) {
  console.log(`\n== ${s.label}`);
  if (s.findings.length === 0) console.log("   no findings");
  for (const f of s.findings) {
    console.log(`   [${f.severity}] ${f.rule}  ${f.where}  ${f.value}${f.note ? "  " + f.note : ""}`);
    if (s.publishes && f.severity === "secret") blocking += 1;
  }
}
console.log(`\nResult: ${blocking === 0 ? "PASS" : "FAIL"} (${blocking} secret-looking value(s) ${isGit ? "in tracked files, untracked files or history" : "in scanned files"})`);
process.exit(blocking === 0 ? 0 : 1);
