import { strict as assert } from "node:assert";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const run = promisify(execFile);
const launcher = fileURLToPath(new URL("./serve-acceptance.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const children = new Set<ChildProcess>();
interface Receipt { url: string; sha: string; trackedDirty: boolean; untrackedDirty: boolean; port: number }

function own(child: ChildProcess) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function start(env: NodeJS.ProcessEnv = {}, args: string[] = [], root = cwd) {
  const child = own(spawn(process.execPath, [join(root, "scripts", "serve-acceptance.mjs"), ...args], {
    cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  const lines = createInterface({ input: child.stdout });
  const receipt = await new Promise<Receipt>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("launcher readiness timeout")); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited before ready: ${code}`)); });
    lines.on("line", (line) => {
      try {
        const value: unknown = JSON.parse(line);
        assert.ok(typeof value === "object" && value !== null);
        assert.ok("url" in value && typeof value.url === "string");
        assert.ok("sha" in value && typeof value.sha === "string");
        assert.ok("trackedDirty" in value && typeof value.trackedDirty === "boolean");
        assert.ok("untrackedDirty" in value && typeof value.untrackedDirty === "boolean");
        assert.ok("port" in value && typeof value.port === "number");
        clearTimeout(timer);
        lines.close();
        child.stdout?.resume();
        resolve({ url: value.url, sha: value.sha, trackedDirty: value.trackedDirty, untrackedDirty: value.untrackedDirty, port: value.port });
      } catch { return; }
    });
    child.stderr?.resume();
  });
  return { child, receipt };
}

async function cleanup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("launcher did not close gracefully")); }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      try { assert.deepEqual([code, signal], [0, null]); resolve(); }
      catch (error) { reject(error); }
    });
    child.kill("SIGTERM");
  });
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "acceptance-source-"));
  const ui = join(root, "ui");
  const fixtureChildren: ChildProcess[] = [];
  t.after(async () => {
    try { await Promise.all(fixtureChildren.map(cleanup)); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  for (const directory of ["scripts", "e2e", "src"]) await mkdir(join(ui, directory), { recursive: true });
  await symlink(join(cwd, "node_modules"), join(ui, "node_modules"), "dir");
  for (const file of ["scripts/serve-acceptance.mjs", "e2e/agent-setup.spec.ts", "vite.config.ts", "package.json"]) {
    await copyFile(join(cwd, file), join(ui, file));
  }
  await writeFile(join(root, ".gitignore"), "node_modules/\n.vite/\n");
  const probe = join(ui, "src", "probe.tsx");
  await writeFile(probe, "export default 0;\n");
  const git = async (...args: string[]) => (await run("git", args, { cwd: root })).stdout;
  const launch = async (env: NodeJS.ProcessEnv = {}) => {
    const server = await start(env, [], ui);
    fixtureChildren.push(server.child);
    return server;
  };
  return { ui, probe, git, launch };
}

async function connect(url: string) {
  const socket = new WebSocket(url.replace(/^http/, "ws"), "vite-hmr");
  const message = once(socket, "message", { signal: AbortSignal.timeout(5_000) });
  await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
  const [event] = await message;
  assert.deepEqual(JSON.parse(String((event as MessageEvent).data)), { type: "connected" });
  return socket;
}

afterEach(async () => { await Promise.all([...children].map(cleanup)); });

describe("serve-acceptance public CLI", { timeout: 30_000 }, () => {
  it("becomes ready after Vite logs stale dependency-cache re-optimization", async (t) => {
    const { ui, git, launch } = await fixture(t);
    await git("init");
    await git("add", ".");
    await git("-c", "user.name=Acceptance test", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Acceptance fixture");
    const cache = join(ui, ".vite", "deps");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "_metadata.json"), JSON.stringify({
      hash: "stale", lockfileHash: "stale", configHash: "stale", browserHash: "stale", optimized: {}, chunks: {},
    }));
    const { receipt } = await launch();
    assert.equal(receipt.sha, (await git("rev-parse", "HEAD")).trim());
    const response = await fetch(`${receipt.url}/__acceptance`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as Receipt).port, receipt.port);
  });

  it("serves the real UI, boundary-fake host, provenance, and audit DOM", async () => {
    const { receipt } = await start();
    assert.match(receipt.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(receipt.sha, /^[0-9a-f]{40}$/);
    assert.equal(receipt.port, Number(new URL(receipt.url).port));
    for (const query of ["", "?other=value"]) {
      const response = await fetch(`${receipt.url}/host${query}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `/host?${query ? "other=value&" : ""}scenario=success`);
      await response.text();
    }
    const defaultHost = await fetch(`${receipt.url}/host`);
    assert.equal(defaultHost.status, 200);
    assert.equal(defaultHost.url, `${receipt.url}/host?scenario=success`);
    await defaultHost.text();
    const emptyScenario = await fetch(`${receipt.url}/host?scenario=`);
    assert.equal(emptyScenario.status, 200);
    assert.equal(emptyScenario.redirected, false);
    await emptyScenario.text();
    const host = await fetch(`${receipt.url}/host?scenario=success`);
    const html = await host.text();
    assert.equal(host.status, 200);
    assert.match(html, /<iframe[^>]+title="Agent setup"/);
    assert.match(html, /parentOrigin=/);
    assert.match(html, /id="acceptance-audit"/);
    const ui = await fetch(`${receipt.url}/?parentOrigin=${encodeURIComponent(receipt.url)}`);
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /src="\/src\//);
    const provenance = await fetch(`${receipt.url}/__acceptance`);
    assert.equal(provenance.status, 200);
    assert.deepEqual(await provenance.json(), { sha: receipt.sha, trackedDirty: receipt.trackedDirty, untrackedDirty: receipt.untrackedDirty, port: receipt.port, boundary: "fake-fixture-evidence" });
  });

  it("keeps concurrent WebSocket transports on their own HTTP listeners", async () => {
    const first = await start();
    const second = await start();
    assert.notEqual(first.receipt.port, second.receipt.port);
    const firstSocket = await connect(first.receipt.url);
    const secondSocket = await connect(second.receipt.url);
    const firstClosed = once(firstSocket, "close", { signal: AbortSignal.timeout(5_000) });
    await cleanup(first.child);
    const [closed] = await firstClosed;
    assert.equal((closed as CloseEvent).code, 1001);
    assert.equal(secondSocket.readyState, WebSocket.OPEN);
    assert.equal((await fetch(`${second.receipt.url}/__acceptance`)).status, 200);
    const anotherSocket = await connect(second.receipt.url);
    const secondClosed = once(secondSocket, "close", { signal: AbortSignal.timeout(5_000) });
    const anotherClosed = once(anotherSocket, "close", { signal: AbortSignal.timeout(5_000) });
    await cleanup(second.child);
    assert.equal(((await secondClosed)[0] as CloseEvent).code, 1001);
    assert.equal(((await anotherClosed)[0] as CloseEvent).code, 1001);
  });

  it("refuses mismatched or changed source and a colliding private port", async (t) => {
    await assert.rejects(() => start({ EXPECTED_SHA: "0".repeat(40) }));
    const first = await start({}, ["--port", "0"]);
    const second = own(spawn(process.execPath, [launcher, "--port", String(first.receipt.port)], { cwd, env: process.env, stdio: "ignore" }));
    const code = await new Promise<number | null>((resolve, reject) => {
      second.once("error", reject);
      second.once("exit", resolve);
    });
    assert.notEqual(code, 0);
    await cleanup(first.child);

    const { ui: fixtureUi, probe, git, launch } = await fixture(t);
    await assert.rejects(
      () => run(process.execPath, [join(fixtureUi, "scripts", "serve-acceptance.mjs")], { cwd: fixtureUi, env: { ...process.env, EXPECTED_SHA: "invalid" } }),
      /EXPECTED_SHA must be a full 40-character git SHA/,
    );
    await git("init");
    await git("add", ".");
    await git("-c", "user.name=Acceptance test", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Acceptance fixture");
    const sourceSha = (await git("rev-parse", "HEAD")).trim();
    const original = await readFile(probe, "utf8");
    for (const change of ["clean", "dirty", "head"]) {
      if (change === "dirty") await writeFile(probe, "export default 1;\n");
      const before = await readFile(probe, "utf8");
      const statusBefore = await git("status", "--porcelain", "--untracked-files=no");
      const server = await launch({ EXPECTED_SHA: change === "dirty" ? undefined : sourceSha });
      assert.equal(server.receipt.trackedDirty, change === "dirty");
      assert.equal((await fetch(`${server.receipt.url}/__acceptance`)).status, 200);
      if (change === "head") {
        await git("-c", "user.name=Acceptance test", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "New source identity");
      } else {
        await writeFile(probe, "export default 2;\n");
        if (change === "dirty") assert.equal(await git("status", "--porcelain", "--untracked-files=no"), statusBefore);
      }
      for (const path of ["/__acceptance", "/host", "/host?scenario=success", "/", "/src/probe.tsx"]) {
        const response = await fetch(`${server.receipt.url}${path}`, { redirect: "manual" });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: "source changed; restart the acceptance launcher" });
      }
      if (change !== "head") {
        await writeFile(probe, before);
        assert.equal((await fetch(`${server.receipt.url}/__acceptance`)).status, 409);
      }
      await cleanup(server.child);
      await writeFile(probe, original);
    }
  });

  it("attests nonignored untracked files and invalidates on their changes", async (t) => {
    const { ui, git, launch } = await fixture(t);
    await git("init");
    await git("add", ".");
    await git("-c", "user.name=Acceptance test", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Acceptance fixture");
    const sha = (await git("rev-parse", "HEAD")).trim();
    const sibling = join(ui, "src", "probe.js");
    await mkdir(join(ui, ".vite"), { recursive: true });
    await writeFile(join(ui, ".vite", "ignored.js"), "ignored\n");
    const clean = await launch({ EXPECTED_SHA: sha });
    assert.equal(clean.receipt.trackedDirty, false);
    assert.equal(clean.receipt.untrackedDirty, false);
    assert.equal((await fetch(`${clean.receipt.url}/__acceptance`)).status, 200);
    await writeFile(join(ui, ".vite", "ignored.js"), "changed but ignored\n");
    assert.equal((await fetch(`${clean.receipt.url}/__acceptance`)).status, 200);
    await writeFile(sibling, "export default 1;\n");
    assert.equal((await fetch(`${clean.receipt.url}/__acceptance`)).status, 409);
    await cleanup(clean.child);
    await assert.rejects(() => start({ EXPECTED_SHA: sha }, [], ui), /launcher exited before ready/);

    const changed = await launch();
    assert.equal(changed.receipt.trackedDirty, false);
    assert.equal(changed.receipt.untrackedDirty, true);
    const status = await git("status", "--porcelain", "--untracked-files=no");
    await writeFile(sibling, "export default 2;\n");
    assert.equal(await git("status", "--porcelain", "--untracked-files=no"), status);
    assert.equal((await fetch(`${changed.receipt.url}/__acceptance`)).status, 409);
    await cleanup(changed.child);

    const removed = await launch();
    await rm(sibling);
    assert.equal((await fetch(`${removed.receipt.url}/__acceptance`)).status, 409);
    await cleanup(removed.child);

    const rootFile = join(dirname(ui), "untracked-root.txt");
    await writeFile(rootFile, "outside ui\n");
    await assert.rejects(() => start({ EXPECTED_SHA: sha }, [], ui), /launcher exited before ready/);
    const rootChanged = await launch();
    assert.equal(rootChanged.receipt.trackedDirty, false);
    assert.equal(rootChanged.receipt.untrackedDirty, true);
    await rm(rootFile);
    assert.equal((await fetch(`${rootChanged.receipt.url}/__acceptance`)).status, 409);
    await cleanup(rootChanged.child);
  });

  it("serves an unknown scenario as a boundary-fake fixture", async () => {
    const { receipt } = await start();
    const response = await fetch(`${receipt.url}/host?scenario=unknown-fixture`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /fake-fixture-evidence/);
  });

  it("releases its port on SIGTERM without changing tracked status", async () => {
    const before = (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd })).stdout;
    const first = await start();
    const exited = once(first.child, "exit", { signal: AbortSignal.timeout(5_000) });
    first.child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(first.receipt.port, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const after = (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd })).stdout;
    assert.equal(after, before);
  });
});
