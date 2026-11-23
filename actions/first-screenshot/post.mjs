// Posts odr shot results: job summary always; PR comment with images when the token can write.
// Images go to an orphan branch (default odr-screenshots) under pr-<n>/<sha>/<platform>/ so the
// comment can embed them. Fork PRs get the summary and the artifact only.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const { shotMarkdown } = await import(pathToFileURL(join(env.ODR_ROOT, "dist/bench/shot.js")).href);
const file = join(env.DIR, "shot.json");
if (!existsSync(file)) {
  console.log("no shot.json; nothing to post");
  process.exit(0);
}
const result = JSON.parse(readFileSync(file, "utf8"));
const repo = env.GITHUB_REPOSITORY;
const api = env.GITHUB_API_URL ?? "https://api.github.com";
const server = env.GITHUB_SERVER_URL ?? "https://github.com";
const branch = env.BRANCH || "odr-screenshots";
const summary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);

async function gh(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  return text ? JSON.parse(text) : {};
}

async function ensureBranch() {
  try {
    await gh("GET", `/repos/${repo}/git/ref/heads/${branch}`);
    return;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  // Orphan branch: one README, no parent, so it shares no history with the code.
  const blob = await gh("POST", `/repos/${repo}/git/blobs`, { content: "Screenshots posted by the OpenDeviceRouter first-screenshot action. Safe to delete.\n", encoding: "utf-8" });
  const tree = await gh("POST", `/repos/${repo}/git/trees`, { tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob.sha }] });
  const commit = await gh("POST", `/repos/${repo}/git/commits`, { message: "odr-screenshots: start", tree: tree.sha, parents: [] });
  await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
}

async function putFile(path, buf) {
  let sha;
  try {
    sha = (await gh("GET", `/repos/${repo}/contents/${path}?ref=${branch}`)).sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  await gh("PUT", `/repos/${repo}/contents/${path}`, { message: `odr shot ${path}`, content: buf.toString("base64"), branch, ...(sha ? { sha } : {}) });
}

const pr = env.PR;
const sameRepo = !env.HEAD_REPO || env.HEAD_REPO === repo;
let posted = false;
if (env.COMMENT !== "false" && pr && sameRepo && env.GH_TOKEN) {
  try {
    await ensureBranch();
    const base = `pr-${pr}/${env.SHA.slice(0, 12)}/${result.platform}`;
    const urls = {};
    for (const f of Object.values(result.files)) {
      await putFile(`${base}/${f}`, readFileSync(join(env.DIR, f)));
      urls[f] = `${server}/${repo}/blob/${branch}/${base}/${f}?raw=true`;
    }
    const body = shotMarkdown(result, (f) => urls[f]);
    const marker = `<!-- odr-first-screenshot:${result.platform} -->`;
    const comments = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100`);
    const mine = comments.find((c) => c.body?.startsWith(marker));
    if (mine) await gh("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
    else await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    summary(body);
    posted = true;
    console.log(`posted ${result.platform} screenshots to PR #${pr}`);
  } catch (e) {
    console.log(`::warning::could not post the PR comment (${e.message}). Add permissions: contents: write, pull-requests: write. Falling back to the job summary.`);
  }
}
if (!posted) {
  summary(shotMarkdown(result));
  summary("\nScreenshots are in the run artifact `odr-first-screenshot-*`.");
}
