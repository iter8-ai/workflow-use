import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createServer } from "vite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const uiRoot = dirname(scriptDir);
const specPath = join(uiRoot, "e2e", "agent-setup.spec.ts");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: uiRoot, encoding: "utf8" }).trim();
const trackedDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: uiRoot, encoding: "utf8" }).trim() !== "";
const expectedSha = process.env.EXPECTED_SHA;

if (expectedSha !== undefined && !/^[0-9a-f]{40}$/i.test(expectedSha)) fail("EXPECTED_SHA must be a full 40-character git SHA");
if (expectedSha !== undefined && expectedSha.toLowerCase() !== sha.toLowerCase()) fail("EXPECTED_SHA does not match HEAD");
if (expectedSha !== undefined && trackedDirty) fail("candidate has tracked changes");

const requestedPort = parsePort(process.argv.slice(2));
const hostPage = loadHostPage();
const vite = await createServer({
  root: uiRoot,
  configFile: join(uiRoot, "vite.config.ts"),
  server: { middlewareMode: true },
});

const acceptanceMiddleware = (request, response, next) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/__acceptance") {
    return sendJson(response, 200, { sha, trackedDirty, port: actualPort(), boundary: "fake-fixture-evidence" });
  }
  if (requestUrl.pathname === "/host") {
    const scenario = requestUrl.searchParams.get("scenario") ?? "success";
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(addAuditDom(hostPage(loopbackUrl(), scenario)));
    return;
  }
  next();
};
const httpServer = createHttpServer((request, response) => acceptanceMiddleware(request, response, () => vite.middlewares(request, response)));

try {
  await new Promise((resolve, reject) => httpServer.once("error", reject).listen(requestedPort, "127.0.0.1", resolve));
  const url = loopbackUrl();
  const readyHost = await (await fetch(`${url}/host?scenario=success`)).text();
  if (!readyHost.includes("fake-fixture-evidence")) throw new Error("acceptance host route did not become ready");
  process.stdout.write(`${JSON.stringify({ url, sha, trackedDirty, port: actualPort() })}\n`);
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
    await vite.close();
    await new Promise((resolve) => httpServer.close(resolve));
    process.exit(0);
  });
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
