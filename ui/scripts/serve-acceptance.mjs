import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createServer } from "vite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const uiRoot = dirname(scriptDir);
const specPath = join(uiRoot, "e2e", "agent-setup.spec.ts");
const expectedSha = process.env.EXPECTED_SHA;
if (expectedSha !== undefined && !/^[0-9a-f]{40}$/i.test(expectedSha)) fail("EXPECTED_SHA must be a full 40-character git SHA");
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: uiRoot }).toString().trim();
const startupSource = sourceIdentity();
const { sha, trackedDirty, untrackedDirty } = startupSource;
let sourceChanged = false;
if (expectedSha !== undefined && expectedSha.toLowerCase() !== sha.toLowerCase()) fail("EXPECTED_SHA does not match HEAD");
if (expectedSha !== undefined && trackedDirty) fail("candidate has tracked changes");
if (expectedSha !== undefined && untrackedDirty) fail("candidate has nonignored untracked files");

const requestedPort = parsePort(process.argv.slice(2));
const hostPage = loadHostPage();
let vite;
const httpServer = createHttpServer((request, response) => acceptanceMiddleware(request, response, () => vite.middlewares(request, response)));
vite = await createServer({
  root: uiRoot,
  configFile: join(uiRoot, "vite.config.ts"),
  server: { middlewareMode: true, hmr: { server: httpServer } },
});

const acceptanceMiddleware = (request, response, next) => {
  if (!sourceChanged) {
    try { sourceChanged = sourceIdentity().fingerprint !== startupSource.fingerprint; }
    catch { sourceChanged = true; }
  }
  if (sourceChanged) return sendJson(response, 409, { error: "source changed; restart the acceptance launcher" });
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/__acceptance") {
    return sendJson(response, 200, { sha, trackedDirty, untrackedDirty, port: actualPort(), boundary: "fake-fixture-evidence" });
  }
  if (requestUrl.pathname === "/host") {
    const scenario = requestUrl.searchParams.get("scenario");
    if (scenario === null) {
      requestUrl.searchParams.set("scenario", "success");
      response.writeHead(302, { location: `${requestUrl.pathname}${requestUrl.search}` });
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(addAuditDom(hostPage(loopbackUrl(), scenario)));
    return;
  }
  next();
};
try {
  await new Promise((resolve, reject) => httpServer.once("error", reject).listen(requestedPort, "127.0.0.1", resolve));
  const url = loopbackUrl();
  const readyHost = await (await fetch(`${url}/host?scenario=success`)).text();
  if (!readyHost.includes("fake-fixture-evidence")) throw new Error("acceptance host route did not become ready");
  process.stdout.write(`${JSON.stringify({ url, sha, trackedDirty, untrackedDirty, port: actualPort() })}\n`);
} catch (error) {
  await vite.close().catch(() => {});
  httpServer.close();
  fail(error instanceof Error ? error.message : String(error));
}

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    const sockets = [...vite.ws.clients].map((client) => client.socket);
    const closed = sockets.map((socket) => new Promise((resolve) => socket.once("close", resolve)));
    for (const socket of sockets) socket.close(1001);
    await Promise.all(closed);
    await vite.close();
    await new Promise((resolve) => httpServer.close(resolve));
    process.exit(0);
  });
}

function sourceIdentity() {
  const git = (args) => execFileSync("git", args, { cwd: uiRoot });
  const sha = git(["rev-parse", "HEAD"]).toString().trim();
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  const diff = git(["diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--binary", "HEAD"]);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repoRoot }).toString().split("\0").filter(Boolean);
  const hash = createHash("sha256").update(sha).update(status).update(diff);
  for (const path of untracked) {
    const fullPath = join(repoRoot, path);
    hash.update(path).update("\0");
    hash.update(lstatSync(fullPath).isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath));
    hash.update("\0");
  }
  return { sha, trackedDirty: status.toString().trim() !== "", untrackedDirty: untracked.length !== 0, fingerprint: hash.digest("hex") };
}

function loadHostPage() {
  const source = readFileSync(specPath, "utf8");
  const file = ts.createSourceFile(specPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "hostPage");
  if (!declaration) fail("hostPage fixture was not found");
  const emitted = ts.transpileModule(source.slice(declaration.pos, declaration.end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(`return ${emitted}`)();
}

function addAuditDom(html) {
  const audit = `<pre id="acceptance-audit" data-testid="acceptance-audit" data-boundary="fake-fixture-evidence" hidden></pre><script>(function(){const p=document.getElementById("acceptance-audit");const values=()=>({boundary:"fake-fixture-evidence",methods:window.__requestMethods??null,reads:window.__runReads??null,close:window.__closeRequests??null,test:window.__testArguments??null,save:window.__savedAgents??null,stop:window.__stopRequests??null});const update=()=>{p.textContent=JSON.stringify(values())};update();setInterval(update,50)})();</script>`;
  return html.replace("</body>", `${audit}</body>`);
}

function parsePort(args) {
  const index = args.indexOf("--port");
  if (index === -1) return 0;
  const value = args[index + 1];
  if (!/^\d+$/.test(value ?? "")) fail("--port must be an integer");
  const port = Number(value);
  if (port !== 0 && (port < 1024 || port > 65535)) fail("--port must be 0 or a private port from 1024 through 65535");
  return port;
}

function actualPort() {
  const address = httpServer.address();
  if (!address || typeof address === "string") fail("Vite did not expose a loopback port");
  return address.port;
}

function loopbackUrl() { return `http://127.0.0.1:${actualPort()}`; }
function sendJson(response, status, body) { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); }
function fail(message) { console.error(`serve-acceptance: ${message}`); process.exitCode = 1; throw new Error(message); }
