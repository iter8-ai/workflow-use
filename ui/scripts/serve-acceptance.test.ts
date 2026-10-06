import { strict as assert } from "node:assert";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const run = promisify(execFile);
const launcher = fileURLToPath(new URL("./serve-acceptance.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const children = new Set<ChildProcess>();
interface Receipt { url: string; sha: string; trackedDirty: boolean; port: number }

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
  const receipt = await new Promise<Receipt>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("launcher readiness timeout")); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited before ready: ${code}`)); });
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (!text.includes("\n")) return;
      clearTimeout(timer);
      try {
        const value: unknown = JSON.parse(text.split("\n")[0] ?? "");
        assert.ok(typeof value === "object" && value !== null);
        assert.ok("url" in value && typeof value.url === "string");
        assert.ok("sha" in value && typeof value.sha === "string");
        assert.ok("trackedDirty" in value && typeof value.trackedDirty === "boolean");
        assert.ok("port" in value && typeof value.port === "number");
        resolve({ url: value.url, sha: value.sha, trackedDirty: value.trackedDirty, port: value.port });
      } catch (error) { child.kill("SIGKILL"); reject(error); }
    });
    child.stderr?.resume();
  });
  return { child, receipt };
}

async function cleanup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

afterEach(async () => { await Promise.all([...children].map(cleanup)); });

describe("serve-acceptance public CLI", { timeout: 30_000 }, () => {
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
    assert.deepEqual(await provenance.json(), { sha: receipt.sha, trackedDirty: receipt.trackedDirty, port: receipt.port, boundary: "fake-fixture-evidence" });
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

    const fixture = await mkdtemp(join(cwd, ".acceptance-source-"));
    const fixtureUi = join(fixture, "ui");
    const fixtureChildren: ChildProcess[] = [];
    t.after(async () => {
      await Promise.all(fixtureChildren.map(cleanup));
      await rm(fixture, { recursive: true, force: true });
    });
    for (const directory of ["scripts", "e2e", "src"]) await mkdir(join(fixtureUi, directory), { recursive: true });
    for (const file of ["scripts/serve-acceptance.mjs", "e2e/agent-setup.spec.ts", "vite.config.ts", "package.json"]) {
      await copyFile(join(cwd, file), join(fixtureUi, file));
    }
    await writeFile(join(fixture, ".gitignore"), "node_modules/\n.vite/\n");
    const probe = join(fixtureUi, "src", "probe.ts");
    await writeFile(probe, "export default 0;\n");
    const git = async (...args: string[]) => (await run("git", args, { cwd: fixture })).stdout;
    await git("init");
    await git("add", ".");
    await git("-c", "user.name=Acceptance test", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Acceptance fixture");
    const sourceSha = (await git("rev-parse", "HEAD")).trim();
    const original = await readFile(probe, "utf8");
    for (const change of ["clean", "dirty", "head"]) {
      if (change === "dirty") await writeFile(probe, "export default 1;\n");
      const before = await readFile(probe, "utf8");
      const statusBefore = await git("status", "--porcelain", "--untracked-files=no");
      const server = await start({ EXPECTED_SHA: change === "dirty" ? undefined : sourceSha }, [], fixtureUi);
      fixtureChildren.push(server.child);
      assert.equal(server.receipt.trackedDirty, change === "dirty");
      assert.equal((await fetch(`${server.receipt.url}/__acceptance`)).status, 200);
      if (change === "head") {
        await git("-c", "user.name=Acceptance test", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "New source identity");
      } else {
        await writeFile(probe, "export default 2;\n");
        if (change === "dirty") assert.equal(await git("status", "--porcelain", "--untracked-files=no"), statusBefore);
      }
      for (const path of ["/__acceptance", "/host", "/host?scenario=success", "/", "/src/probe.ts"]) {
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
