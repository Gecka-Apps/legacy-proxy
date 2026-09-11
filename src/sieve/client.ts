// Minimal ManageSieve client (RFC 5804). Implements the verbs we need:
// CAPABILITY, AUTHENTICATE PLAIN, LISTSCRIPTS, GETSCRIPT, PUTSCRIPT,
// CHECKSCRIPT, SETACTIVE, DELETESCRIPT, RENAMESCRIPT, LOGOUT.
//
// The protocol is line-oriented, NUL-clean, with literals declared as
// `{N+}` (LITERAL+) or `{N}\r\n`. We support both literal forms, in both
// directions: Dovecot answers a failed PUTSCRIPT / CHECKSCRIPT with a
// multi-line compile log carried as a `{N}` literal on the NO line.

import { TLSSocket, connect as tlsConnect } from "node:tls";
import { Socket, connect as netConnect } from "node:net";
import type { Credentials } from "../auth/credentials.js";

interface SieveOpts {
  host: string;
  port: number;
  starttls?: boolean;
  secure?: boolean;
  creds: Credentials;
  servername?: string;
}

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

/** What the server announced in its greeting (RFC 5804 §1.7). */
export interface SieveServerCapabilities {
  implementation: string | null;
  /** Sieve extensions from the SIEVE capability line, e.g. ["fileinto", "vacation"]. */
  extensions: string[];
  /** Notification methods from NOTIFY, e.g. ["mailto"]. */
  notify: string[];
  maxRedirects: number | null;
}

/** A NO / BYE answer, with the server's explanation (compile log, quota…). */
export class SieveCommandError extends Error {
  readonly verb: string;
  readonly response: string;
  /** RFC 5804 §1.3 response code, e.g. "QUOTA/MAXSCRIPTS", "NONEXISTENT", "ACTIVE". */
  readonly code: string | null;
  constructor(verb: string, response: string) {
    const code = /^(?:NO|BYE)\s+\(([^)]*)\)/.exec(response)?.[1] ?? null;
    super(`${verb}: ${humanText(response)}`);
    this.verb = verb;
    this.response = response;
    this.code = code;
  }
}

/**
 * Strip the status word, the optional response code and the quotes around a
 * server message: `NO (QUOTA) "Too many scripts"` → `Too many scripts`.
 */
export function humanText(response: string): string {
  let s = response.replace(/^(?:OK|NO|BYE)\b\s*/, "").replace(/^\([^)]*\)\s*/, "");
  const m = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(s);
  if (m && m[1] !== undefined) s = m[1].replace(/\\(.)/g, "$1");
  return s.trim();
}

export class SieveClient {
  private sock!: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  private pending: (() => void) | null = null;
  private capabilities = new Map<string, string>();
  private opts: SieveOpts;

  constructor(opts: SieveOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.sock = this.opts.secure
        ? tlsConnect({ host: this.opts.host, port: this.opts.port, servername: this.opts.servername ?? this.opts.host }, () => {
            this.sock.off("error", onErr);
            resolve();
          })
        : netConnect({ host: this.opts.host, port: this.opts.port }, () => {
            this.sock.off("error", onErr);
            resolve();
          });
      this.sock.on("error", onErr);
      this.attachReader();
    });
    await this.readGreeting();
    if (this.opts.starttls && !(this.sock instanceof TLSSocket)) {
      await this.startTls();
    }
    await this.authenticate();
  }

  /** Capabilities announced in the (post-STARTTLS) greeting. */
  serverCapabilities(): SieveServerCapabilities {
    const split = (s: string | undefined) => (s ?? "").split(/\s+/).map((x) => x.trim()).filter(Boolean);
    const maxRaw = this.capabilities.get("MAXREDIRECTS");
    const max = maxRaw !== undefined && /^\d+$/.test(maxRaw) ? Number(maxRaw) : null;
    return {
      implementation: this.capabilities.get("IMPLEMENTATION") ?? null,
      extensions: split(this.capabilities.get("SIEVE")),
      notify: split(this.capabilities.get("NOTIFY")),
      maxRedirects: max,
    };
  }

  private attachReader(): void {
    this.sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const cb = this.pending;
      if (cb) {
        this.pending = null;
        cb();
      }
    });
  }

  /** Resolve as soon as more bytes are available. */
  private waitForData(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }

  private tryReadLine(): string | null {
    const idx = this.buf.indexOf("\r\n");
    if (idx < 0) return null;
    const line = this.buf.subarray(0, idx).toString("utf8");
    this.buf = this.buf.subarray(idx + 2);
    return line;
  }

  private async readLine(): Promise<string> {
    while (true) {
      const line = this.tryReadLine();
      if (line !== null) return line;
      await this.waitForData();
    }
  }

  private async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.waitForData();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }

  /**
   * Read one response line, folding in a trailing `{N}` literal when the
   * server continues its message on the following lines. Returns the line
   * with the literal's text substituted for the `{N}` marker so callers can
   * treat the result as a single string.
   */
  private async readResponseLine(): Promise<string> {
    const line = await this.readLine();
    const lit = /^(.*)\{(\d+)\+?\}$/.exec(line);
    if (!lit || lit[2] === undefined) return line;
    const n = Number(lit[2]);
    const body = (await this.readBytes(n)).toString("utf8");
    // The literal is followed by CRLF before the next line (or end of response).
    await this.consumeCrlf();
    return `${lit[1] ?? ""}"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  private async consumeCrlf(): Promise<void> {
    while (this.buf.length < 2) await this.waitForData();
    if (this.buf[0] === 0x0d && this.buf[1] === 0x0a) this.buf = this.buf.subarray(2);
  }

  private async readGreeting(): Promise<void> {
    while (true) {
      const line = await this.readLine();
      if (line.startsWith("OK")) return;
      if (line.startsWith("\"")) {
        const m = /^"([^"]+)"(?:\s+"([^"]*)")?/.exec(line);
        if (m && m[1]) this.capabilities.set(m[1].toUpperCase(), m[2] ?? "");
        continue;
      }
      if (line.startsWith("BYE") || line.startsWith("NO")) {
        throw new Error(`SIEVE greeting failed: ${line}`);
      }
    }
  }

  private async startTls(): Promise<void> {
    this.sock.write("STARTTLS\r\n");
    const ack = await this.readLine();
    if (!ack.startsWith("OK")) throw new Error(`STARTTLS rejected: ${ack}`);
    const plain = this.sock as Socket;
    plain.removeAllListeners("data");
    const tls = tlsConnect({
      socket: plain,
      servername: this.opts.servername ?? this.opts.host,
    });
    await new Promise<void>((res, rej) => {
      tls.once("secureConnect", () => res());
      tls.once("error", (e) => rej(e));
    });
    this.sock = tls;
    this.buf = Buffer.alloc(0);
    this.attachReader();
    this.capabilities.clear();
    await this.readGreeting();
  }

  private async authenticate(): Promise<void> {
    const c = this.opts.creds;
    if (c.mech === "PLAIN" && c.password) {
      const blob = Buffer.from(`\x00${c.username}\x00${c.password}`).toString("base64");
      this.sock.write(`AUTHENTICATE "PLAIN" {${blob.length}+}\r\n${blob}\r\n`);
    } else {
      throw new Error(`unsupported sieve auth mech: ${c.mech}`);
    }
    const line = await this.readLine();
    if (!line.startsWith("OK")) throw new Error(`AUTH failed: ${line}`);
  }

  /** Send a verb and read its final OK/NO/BYE line (folding any literal). */
  private async simple(verb: string, wire: string, payload?: Buffer): Promise<string> {
    this.sock.write(wire);
    if (payload) {
      this.sock.write(payload);
      this.sock.write("\r\n");
    }
    const line = await this.readResponseLine();
    if (!line.startsWith("OK")) throw new SieveCommandError(verb, line);
    return line;
  }

  async listScripts(): Promise<SieveScriptInfo[]> {
    this.sock.write("LISTSCRIPTS\r\n");
    const out: SieveScriptInfo[] = [];
    while (true) {
      const line = await this.readResponseLine();
      if (line.startsWith("OK")) return out;
      if (line.startsWith("NO") || line.startsWith("BYE")) throw new SieveCommandError("LISTSCRIPTS", line);
      const m = /^"((?:[^"\\]|\\.)*)"(?:\s+(\S+))?/.exec(line);
      if (m && m[1] !== undefined) out.push({ name: m[1].replace(/\\(.)/g, "$1"), active: m[2] === "ACTIVE" });
    }
  }

  async putScript(name: string, body: string): Promise<void> {
    const buf = Buffer.from(body, "utf8");
    await this.simple("PUTSCRIPT", `PUTSCRIPT ${quote(name)} {${buf.length}+}\r\n`, buf);
  }

  /** CHECKSCRIPT (RFC 5804 §2.12): compile without storing. Throws on error. */
  async checkScript(body: string): Promise<void> {
    const buf = Buffer.from(body, "utf8");
    await this.simple("CHECKSCRIPT", `CHECKSCRIPT {${buf.length}+}\r\n`, buf);
  }

  /** SETACTIVE; an empty name deactivates whatever is active (RFC 5804 §2.8). */
  async setActive(name: string): Promise<void> {
    await this.simple("SETACTIVE", `SETACTIVE ${quote(name)}\r\n`);
  }

  async deleteScript(name: string): Promise<void> {
    await this.simple("DELETESCRIPT", `DELETESCRIPT ${quote(name)}\r\n`);
  }

  async renameScript(from: string, to: string): Promise<void> {
    await this.simple("RENAMESCRIPT", `RENAMESCRIPT ${quote(from)} ${quote(to)}\r\n`);
  }

  async getScript(name: string): Promise<string> {
    this.sock.write(`GETSCRIPT ${quote(name)}\r\n`);
    const first = await this.readLine();
    const lit = /^\{(\d+)\+?\}$/.exec(first);
    if (!lit || !lit[1]) {
      if (first.startsWith("NO") || first.startsWith("BYE")) throw new SieveCommandError("GETSCRIPT", first);
      throw new Error(`GETSCRIPT unexpected: ${first}`);
    }
    const body = (await this.readBytes(Number(lit[1]))).toString("utf8");
    await this.consumeCrlf();
    const ok = await this.readResponseLine();
    if (!ok.startsWith("OK")) throw new SieveCommandError("GETSCRIPT", ok);
    return body;
  }

  async logout(): Promise<void> {
    try {
      this.sock.write("LOGOUT\r\n");
    } catch {
      /* socket already gone */
    }
    this.sock.destroy();
  }
}

/** Quote a script name as a ManageSieve string (RFC 5804 §1.6). */
function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
