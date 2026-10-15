// In-memory fake of the GitHub git data API used by Vimmi sync.
// Used by unit tests (as a fetch replacement) and by the end-to-end test (as an HTTP server).
import http from "node:http";
import { gitBlobSha } from "../shared/sync";

export

class FakeGitHub {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message?: string; date?: string }>();
  ref: string | null = null;
  failNextRefUpdate = false;
  requests = 0;
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}${(++this.seq).toString(16).padStart(8, "0")}`;
  }

  private commit(files: Record<string, string>, parent: string | null, message = "Externí změna") {
    const tree = this.id("tree");
    this.trees.set(tree, files);
    const sha = this.id("commit");
    this.commits.set(sha, { tree, parents: parent ? [parent] : [], message, date: new Date().toISOString() });
    return sha;
  }

  /** Current files in the repository: path -> text. */
  snapshot(): Record<string, string> {
    if (!this.ref) return {};
    const files = this.trees.get(this.commits.get(this.ref)!.tree)!;
    return Object.fromEntries(Object.entries(files).map(([p, sha]) => [p, new TextDecoder().decode(this.blobs.get(sha)!)]));
  }

  /** Simulates a push from a third device. */
  async externalCommit(path: string, text: string) {
    const data = new TextEncoder().encode(text);
    const sha = await gitBlobSha(data);
    this.blobs.set(sha, data);
    const files = { ...this.trees.get(this.commits.get(this.ref!)!.tree)!, [path]: sha };
    this.ref = this.commit(files, this.ref);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.requests++;
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/user") return new Response(JSON.stringify({ login: "me" }), { status: 200 });
    const path = url.pathname.replace(/^\/repos\/me\/notes/, "");
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

    if (method === "GET" && path === "") return json(200, { default_branch: "main" });
    if (method === "GET" && path === "/commits") {
      // Commits that changed a file, newest first (like GET /repos/{o}/{r}/commits?path=).
      const file = url.searchParams.get("path")!;
      const out: unknown[] = [];
      for (let sha = this.ref; sha; sha = this.commits.get(sha)!.parents[0] ?? null) {
        const c = this.commits.get(sha)!;
        const parent = c.parents[0] ? this.commits.get(c.parents[0]) : undefined;
        const now = this.trees.get(c.tree)![file];
        const before = parent ? this.trees.get(parent.tree)![file] : undefined;
        if (now !== before) out.push({ sha, commit: { message: c.message ?? "", committer: { date: c.date } } });
      }
      return json(200, out);
    }
    if (method === "GET" && path === "/git/ref/heads/main") {
      return this.ref ? json(200, { object: { sha: this.ref } }) : json(409, { message: "Git Repository is empty." });
    }
    if (method === "PUT" && path.startsWith("/contents/")) {
      const data = Buffer.from(body.content, "base64");
      const sha = await gitBlobSha(new Uint8Array(data));
      this.blobs.set(sha, new Uint8Array(data));
      const prev = this.ref ? this.trees.get(this.commits.get(this.ref)!.tree)! : {};
      this.ref = this.commit({ ...prev, [decodeURIComponent(path.slice(10))]: sha }, this.ref);
      return json(201, {});
    }
    let m = path.match(/^\/git\/commits\/(\w+)$/);
    if (method === "GET" && m) return json(200, { tree: { sha: this.commits.get(m[1])!.tree } });
    m = path.match(/^\/git\/trees\/(\w+)$/);
    if (method === "GET" && m) {
      const files = this.trees.get(m[1])!;
      return json(200, { tree: Object.entries(files).map(([p, sha]) => ({ path: p, type: "blob", sha })), truncated: false });
    }
    m = path.match(/^\/git\/blobs\/(\w+)$/);
    if (method === "GET" && m) return json(200, { content: b64(this.blobs.get(m[1])!), encoding: "base64" });
    if (method === "POST" && path === "/git/blobs") {
      const data = new Uint8Array(Buffer.from(body.content, "base64"));
      const sha = await gitBlobSha(data);
      this.blobs.set(sha, data);
      return json(201, { sha });
    }
    if (method === "POST" && path === "/git/trees") {
      const files = { ...(this.trees.get(body.base_tree) ?? {}) };
      for (const e of body.tree) {
        if (e.sha === null) delete files[e.path];
        else files[e.path] = e.sha;
      }
      const sha = this.id("tree");
      this.trees.set(sha, files);
      return json(201, { sha });
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = this.id("commit");
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message, date: new Date(Date.now() + this.seq).toISOString() });
      return json(201, { sha });
    }
    if (method === "PATCH" && path === "/git/refs/heads/main") {
      const parent = this.commits.get(body.sha)!.parents[0];
      if (this.failNextRefUpdate || parent !== this.ref) {
        this.failNextRefUpdate = false;
        return json(422, { message: "Update is not a fast forward" });
      }
      this.ref = body.sha;
      return json(200, {});
    }
    return json(404, { message: `Not mocked: ${method} ${path}` });
  };
}


/** Serves a FakeGitHub over HTTP (with CORS for the web app). Returns the base URL and a close function. */
export async function serveFakeGitHub(gh: FakeGitHub): Promise<{ url: string; close: () => void }> {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const r = await gh.fetch(`http://fake${req.url}`, { method: req.method, body: body || undefined });
      res.writeHead(r.status, { ...cors, "Content-Type": "application/json" });
      res.end(await r.text());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
