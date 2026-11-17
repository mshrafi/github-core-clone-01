// MCP at POST /mcp: JSON-RPC 2.0 over Streamable HTTP, modern revision
// 2026-07-28 (server/discover, no handshake) plus the legacy initialize
// handshake as a fallback. Six tools over the same store as REST.

import {
  store,
  VIEWER,
  type Repo,
  createIssue,
  createPull,
  squashMerge,
  repoGlobalId,
} from './store.ts';
import { repoJson, issueJson } from './rest.ts';

export interface McpCtx {
  authed: boolean;
  host: string;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// One constant tools list: two tools/list calls answer byte-identical JSON.
const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function resolveRepo(args: Record<string, unknown>): Repo | null {
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  if (fullName.includes('/')) {
    const [owner, name] = fullName.split('/', 2);
    return store.getRepo(owner!, name!) ?? null;
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

function toolText(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: false } {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolErrorText(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>, host: string): { result: unknown; rpcError?: { code: number; message: string } } {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return { result: toolErrorText('create_repo requires a name') };
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing) return { result: toolText(repoJson(existing, host)) };
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return { result: toolText(repoJson(repo!, host)) };
    }
    case 'get_repo': {
      const repo = resolveRepo(args);
      if (!repo) return { result: toolErrorText(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`) };
      return { result: toolText(repoJson(repo, host)) };
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      if (!repo) return { result: toolErrorText('Repository not found') };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { result: toolErrorText('create_issue requires a title') };
      const issue = createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return { result: toolText(issueJson(repo, issue, host)) };
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      if (!repo) return { result: toolErrorText('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      const items = list.map((i) => issueJson(repo, i, host));
      return { result: toolText(items) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      if (!repo) return { result: toolErrorText('Repository not found') };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : 'main';
      if (title === '' || head === '') return { result: toolErrorText('create_pull_request requires a title and a head branch') };
      const pull = createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (!pull) return { result: toolErrorText(`head branch "${head}" or base branch "${base}" does not exist`) };
      const out = {
        id: pull.id,
        node_id: '',
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: false,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      };
      return { result: toolText(out) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      if (!repo) return { result: toolErrorText('Repository not found') };
      const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      if (!Number.isInteger(num)) return { result: toolErrorText('merge_pull_request requires a pull_number') };
      const pull = repo.pulls.get(num);
      if (!pull) return { result: toolErrorText(`Pull request #${num} not found`) };
      if (pull.merged) return { result: toolText({ number: pull.number, merged: true, sha: pull.mergeCommitSha, state: pull.state }) };
      const sha = squashMerge(repo, pull);
      if (sha === null) return { result: toolErrorText('Merge conflict: the head branch conflicts with the base branch') };
      return { result: toolText({ number: pull.number, merged: true, sha, state: pull.state }) };
    }
    default:
      return { result: null, rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const e: Record<string, unknown> = { code, message };
  if (data !== undefined) e.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: e });
}

export function handleMcp(ctx: McpCtx, method: string, rawBody: Buffer): { status: number; body: string; contentType: string } {
  const jsonType = 'application/json';
  if (method === 'DELETE') return { status: 204, body: '', contentType: jsonType };
  if (method !== 'POST') return { status: 405, body: JSON.stringify({ message: 'Method Not Allowed' }), contentType: jsonType };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error'), contentType: jsonType };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request'), contentType: jsonType };
  }
  const req = parsed as Record<string, unknown>;
  const id = 'id' in req ? req.id : null;
  const rpcMethod = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no JSON-RPC response.
  if (id === undefined || id === null) {
    return { status: 202, body: '', contentType: jsonType };
  }

  // Auth is decided before any tool exists.
  if (!ctx.authed) {
    return { status: 401, body: rpcError(id, -32600, 'Unauthorized'), contentType: jsonType };
  }

  if (rpcMethod === 'server/discover') {
    const result = {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
    return { status: 200, body: rpcResult(id, result), contentType: jsonType };
  }

  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (offered !== '' && !SUPPORTED_VERSIONS.includes(offered)) {
      return { status: 200, body: rpcError(id, -32602, `Unsupported protocol version: ${offered}`), contentType: jsonType };
    }
    const result = {
      protocolVersion: offered !== '' ? offered : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    return { status: 200, body: rpcResult(id, result), contentType: jsonType };
  }

  if (rpcMethod === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }), contentType: jsonType };
  }

  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((t) => t.name === name);
    if (!known) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`), contentType: jsonType };
    }
    const { result, rpcError: err } = callTool(name, args, ctx.host);
    if (err) return { status: 200, body: rpcError(id, err.code, err.message), contentType: jsonType };
    return { status: 200, body: rpcResult(id, result), contentType: jsonType };
  }

  if (rpcMethod === 'ping') {
    return { status: 200, body: rpcResult(id, {}), contentType: jsonType };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${rpcMethod}`), contentType: jsonType };
}
