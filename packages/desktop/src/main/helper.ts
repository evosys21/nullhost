// The elevated helper: the only part of NullHost that runs as administrator.
//
// The app (normal user) opens a private named pipe and starts the helper with
// one UAC prompt on the first change of a session. The helper connects to the
// app's pipe (an unelevated process cannot open a pipe owned by an elevated one,
// so the direction is app = server, helper = client), proves itself with a
// one-time secret, and then answers a fixed set of requests until the app quits.
//
// What the helper will do, and nothing else:
//   write     replace the SYSTEM hosts file with the given text (path fixed here)
//   flush     ipconfig /flushdns
//   schedule  install or remove the daily-update task
//   ping
import { randomBytes, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import net from "node:net";
import type { ScheduleStatus, WriteReport } from "@nullhost/core";

export const PIPE_PREFIX = "\\\\.\\pipe\\nullhost-";
/** larger than any hosts file under the 180k-host ceiling (about 7 MB) */
export const MAX_CONTENT = 32 * 1024 * 1024;

export type HelperOp = "ping" | "write" | "flush" | "schedule";

export interface HelperRequest {
  id: number;
  op: HelperOp;
  content?: string;
  at?: string | null;
  dataDir?: string;
  configFile?: string;
  hostsFile?: string;
}

export type HelperResponse = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

export interface HelperHello {
  hello: string;
  pid: number;
  elevated: boolean;
}

export interface HelperContext {
  /** the one file `write` may touch: the system hosts file (a temp copy only in unelevated tests) */
  hostsPath: string;
  elevated: boolean;
  write(path: string, content: string): Promise<WriteReport>;
  flush(): Promise<void>;
  schedule(at: string | null, paths: { dataDir: string; configFile: string; hostsFile?: string }): Promise<ScheduleStatus>;
}

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

function safePath(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 260 || !win32.isAbsolute(v) || /["\u0000-\u001f]/.test(v)) {
    throw new Error(`${what} must be an absolute path without quotes`);
  }
  return v;
}

/** Validate and run one request (exported for tests). Throws with a message the app shows. */
export async function handleHelperRequest(raw: unknown, ctx: HelperContext): Promise<unknown> {
  if (!raw || typeof raw !== "object") throw new Error("bad request");
  const req = raw as Partial<HelperRequest>;
  switch (req.op) {
    case "ping":
      return { pid: process.pid, elevated: ctx.elevated };
    case "write": {
      if (typeof req.content !== "string") throw new Error("write needs the file content");
      if (req.content.length > MAX_CONTENT) throw new Error("hosts file content too large");
      return ctx.write(ctx.hostsPath, req.content);
    }
    case "flush":
      await ctx.flush();
      return null;
    case "schedule": {
      if (req.at !== null && (typeof req.at !== "string" || !TIME.test(req.at))) throw new Error("time must be HH:MM");
      const paths = { dataDir: safePath(req.dataDir, "dataDir"), configFile: safePath(req.configFile, "configFile") } as { dataDir: string; configFile: string; hostsFile?: string };
      if (req.hostsFile !== undefined) {
        // an elevated helper must never point the elevated task at another file
        if (ctx.elevated) throw new Error("hostsFile is not accepted by an elevated helper");
        paths.hostsFile = safePath(req.hostsFile, "hostsFile");
      }
      return ctx.schedule(req.at ?? null, paths);
    }
    default:
      throw new Error(`unknown request: ${String(req.op)}`);
  }
}

/** Split a socket's text stream into lines. */
function onLines(sock: net.Socket, cb: (line: string) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
  });
}

// ---------------------------------------------------------------- helper side

export interface HelperRunOptions {
  pipe: string;
  token: string;
  parentPid?: number;
  ctx: HelperContext;
}

/** The helper process: connect, say hello, answer requests. Resolves with an exit code when the app goes away. */
export function runHelper(o: HelperRunOptions): Promise<number> {
  if (!o.pipe.startsWith(PIPE_PREFIX)) return Promise.resolve(2);
  if (!/^[0-9a-f]{64}$/.test(o.token)) return Promise.resolve(2);
  return new Promise((resolve) => {
    const sock = net.connect(o.pipe);
    let watchdog: NodeJS.Timeout | undefined;
    const done = (code: number) => {
      if (watchdog) clearInterval(watchdog);
      sock.destroy();
      resolve(code);
    };
    sock.on("error", () => done(1));
    sock.on("close", () => done(0));
    sock.on("connect", () => {
      const hello: HelperHello = { hello: o.token, pid: process.pid, elevated: o.ctx.elevated };
      sock.write(JSON.stringify(hello) + "\n");
    });
    // exit with the app even if the pipe stays open somehow
    if (o.parentPid) {
      watchdog = setInterval(() => {
        try {
          process.kill(o.parentPid!, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") done(0);
        }
      }, 5_000);
    }
    // one request at a time, in order
    let chain: Promise<void> = Promise.resolve();
    onLines(sock, (line) => {
      chain = chain.then(async () => {
        let id = -1;
        let res: HelperResponse;
        try {
          const req = JSON.parse(line) as HelperRequest;
          id = typeof req.id === "number" ? req.id : -1;
          res = { id, ok: true, result: await handleHelperRequest(req, o.ctx) };
        } catch (err) {
          res = { id, ok: false, error: (err as Error).message };
        }
        if (!sock.destroyed) sock.write(JSON.stringify(res) + "\n");
      });
    });
  });
}

// ---------------------------------------------------------------- app side

export interface BrokerOptions {
  /** start the helper (elevated, with one UAC prompt); rejects when declined */
  launch: (pipe: string, token: string) => Promise<void>;
  /** called when the helper starts or stops */
  onState?: (running: boolean) => void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The app's end: starts the helper on first use and forwards requests to it. */
export class HelperBroker {
  private sock: net.Socket | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly o: BrokerOptions;

  constructor(o: BrokerOptions) {
    this.o = o;
  }

  get running(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  /** Start the helper if it is not running. One UAC prompt per session. */
  ensure(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const pipe = `${PIPE_PREFIX}${randomUUID()}`;
    const token = randomBytes(32).toString("hex");
    let server: net.Server | undefined;
    const connected = new Promise<net.Socket>((resolve, reject) => {
      server = net.createServer((s) => {
        // the first line must be the hello carrying our one-time secret
        let first = true;
        s.on("error", () => undefined);
        onLines(s, (line) => {
          if (!first) return this.onResponse(line);
          first = false;
          let hello: Partial<HelperHello> = {};
          try {
            hello = JSON.parse(line) as HelperHello;
          } catch {
            /* rejected below */
          }
          if (hello.hello !== token) {
            s.destroy();
            return;
          }
          server?.close(); // exactly one helper
          resolve(s);
        });
      });
      server.on("error", reject);
      server.listen(pipe);
    });
    connected.catch(() => undefined); // a failed launch closes the server; nobody awaits this then
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.o.launch(pipe, token);
      // only now: the user may be looking at the UAC prompt until launch() returns
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the administrator helper did not start in time")), this.o.connectTimeoutMs ?? 120_000);
      });
      const sock = await Promise.race([connected, timeout]);
      this.sock = sock;
      sock.on("close", () => this.onClose());
      this.o.onState?.(true);
    } catch (err) {
      server?.close();
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private onResponse(line: string): void {
    let res: HelperResponse;
    try {
      res = JSON.parse(line) as HelperResponse;
    } catch {
      return;
    }
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  }

  private onClose(): void {
    this.sock = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("the administrator helper stopped"));
    }
    this.pending.clear();
    this.o.onState?.(false);
  }

  async request<T>(op: HelperOp, params: Omit<HelperRequest, "id" | "op"> = {}): Promise<T> {
    await this.ensure();
    const id = this.nextId++;
    const sock = this.sock!;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the administrator helper did not answer (${op})`));
      }, this.o.requestTimeoutMs ?? 120_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  /** Stop the helper (the app is quitting). */
  close(): void {
    this.sock?.end();
    this.sock?.destroy();
  }
}
