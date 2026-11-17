// The forge's HTTP server: one node:http server, in-memory store, four surfaces.
// Routing is plain string work (no regex sprawl); every handler is synchronous
// once the body is read, so concurrent requests cannot interleave a mutation.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store, VIEWER } from './store.ts';
import { handleRest, type Ctx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefsUpload, infoRefsReceive, handleUploadPack, handleReceivePack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// A deterministic per-request id: a counter, never random, never a clock.
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, text: string | null, headers: Record<string, string> = {}): void {
  const body = text ?? '';
  const all: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...headers,
  };
  if (status === 204 || body === '') {
    res.writeHead(status, all);
    res.end();
    return;
  }
  all['content-length'] = String(Buffer.byteLength(body));
  res.writeHead(status, all);
  res.end(body);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = header.slice(7);
  if (given.length !== TOKEN.length) return false;
  // Timing-safe compare without leaking length.
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        // Never crash the server on a request; never leak a stack to the client.
        if (!res.headersSent) {
          sendJson(res, 500, JSON.stringify({ message: 'Internal Server Error' }));
        } else {
          res.end();
        }
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? '127.0.0.1';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${host}`);
  } catch {
    notFound(res);
    return;
  }
  const path = url.pathname;
  const segments = path.split('/').filter((s) => s !== '');

  // The env's boot probe: no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, JSON.stringify({ ok: true }));
    return;
  }

  // ---- MCP ----
  if (path === '/mcp') {
    const raw = await readBody(req);
    const out = handleMcp({ authed: authed(req), host }, method, raw);
    sendJson(res, out.status, out.body === '' ? null : out.body, { 'content-type': out.contentType });
    return;
  }

  // ---- GraphQL ----
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    const raw = await readBody(req);
    const out = handleGraphQL({ authed: authed(req) }, raw);
    sendJson(res, out.status, out.body);
    return;
  }

  // ---- Git smart HTTP: /{owner}/{repo}.git/... (no bearer token on this wire) ----
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = decodeURIComponent(segments[0]!);
    const repoName = decodeURIComponent(segments[1]!.slice(0, -4));
    const tail = segments.slice(2).join('/');
    // Ownership: repos belong to the token's login; any other owner is a 404.
    if (owner !== VIEWER.login) {
      sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (method === 'GET' && tail === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const out = infoRefsUpload(repo, wantV2);
        sendBytes(res, 200, out.body, out.contentType);
        return;
      }
      if (service === 'git-receive-pack') {
        const out = infoRefsReceive(repo);
        sendBytes(res, 200, out.body, out.contentType);
        return;
      }
      notFound(res);
      return;
    }
    if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
      const raw = await readBody(req);
      try {
        if (tail === 'git-upload-pack') {
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          const body = handleUploadPack(repo, raw, isV2);
          sendBytes(res, 200, body, 'application/x-git-upload-pack-result');
        } else {
          const body = handleReceivePack(repo, raw);
          sendBytes(res, 200, body, 'application/x-git-receive-pack-result');
        }
      } catch (err) {
        // A malformed pkt-line or pack must not take the server down; the
        // repo-survives-errors check proves the clone still works afterwards.
        process.stderr.write(`[entry] git ${tail} failed: ${err instanceof Error ? err.message : String(err)}\n`);
        sendJson(res, 400, JSON.stringify({ message: 'Bad Request' }));
      }
      return;
    }
    notFound(res);
    return;
  }

  // ---- REST v3 ----
  if (segments[0] === 'api' && segments[1] === 'v3') {
    let body: unknown = null;
    let rawBody = Buffer.alloc(0);
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      rawBody = await readBody(req);
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          sendJson(res, 400, JSON.stringify({ message: 'Problems parsing JSON' }));
          return;
        }
      }
    }
    const ctx: Ctx = {
      method,
      segments,
      query: url.searchParams,
      body,
      rawBody,
      host,
      authed: authed(req),
    };
    const out = handleRest(ctx);
    if (out === null) {
      notFound(res);
      return;
    }
    if (out.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, out.status, out.body, out.headers ?? {});
    return;
  }

  notFound(res);
}
