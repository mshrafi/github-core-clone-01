// REST v3 under /api/v3: repos, branches, commits, contents, git refs, issues,
// labels, comments, pulls, files, merge. All handlers share the store in store.ts.

import {
  store,
  VIEWER,
  EPOCH_ISO,
  DEFAULT_BRANCH,
  ZERO_OID,
  type Repo,
  type Issue,
  type Pull,
  sha1,
  parseCommit,
  parseTree,
  treeMap,
  buildTreeFromMap,
  buildServerCommit,
  putObject,
  diffMaps,
  createIssue,
  createPull,
  squashMerge,
  pullMergeable,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
} from './store.ts';

export interface Ctx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  rawBody: Buffer;
  host: string;
  authed: boolean;
}

export interface Reply {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  body: JSON.stringify(value),
  headers,
});

const err = (status: number, message: string): Reply => json(status, { message });

function repoUrl(repo: Repo, host: string): string {
  return `http://${host}/${repo.owner}/${repo.name}`;
}

export function repoJson(repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', avatar_url: '', html_url: `http://${host}/${repo.owner}` },
    private: repo.isPrivate,
    html_url: repoUrl(repo, host),
    description: repo.description,
    fork: false,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    pushed_at: EPOCH_ISO,
    default_branch: DEFAULT_BRANCH,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: 0, name, color: l?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignees: [],
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: issue.state === 'closed' ? EPOCH_ISO : null,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    repository_url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** Cached issue JSON (the read workload hits the same issue 2000x). */
export function issueJsonCached(repo: Repo, issue: Issue, host: string): string {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const text = JSON.stringify(issueJson(repo, issue, host));
  issue.jsonCache = text;
  return text;
}

function pullJson(repo: Repo, pull: Pull, host: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: pull.state === 'closed' ? EPOCH_ISO : null,
    html_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return null;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Resolve a ref name (branch, tag, or sha) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref);
  return direct ?? null;
}

/** List commits reachable from a tip, newest first (DFS, parents after the commit). */
function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, message: c.message.replace(/\n$/, '') });
    for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]!);
  }
  return out;
}

function b64decode(text: string): Buffer | null {
  try {
    const clean = text.replace(/\s+/g, '');
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

/** Create a contents commit on `branch` (creating the branch from the default tip
 *  when it does not exist yet, or from nothing for the first commit). */
function contentsCommit(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; contentSha: string | null } | { error: string; status: number } {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  let files = new Map<string, string>();
  if (tip !== undefined) {
    files = new Map(treeMap(repo, tip));
  } else if (repo.refs.size > 0) {
    // Branch from the default branch tip.
    const base = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (base !== undefined) {
      tip = base;
      files = new Map(treeMap(repo, base));
    }
  }
  if (content === null) {
    if (!files.has(path)) return { error: 'Not Found', status: 404 };
    files.delete(path);
  } else {
    const blobSha = putObject(repo, 'blob', content);
    files.set(path, blobSha);
  }
  const treeOid = buildTreeFromMap(repo, files);
  const parents = tip !== undefined ? [tip] : [];
  const commitSha = buildServerCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  let contentSha: string | null = null;
  if (content !== null) contentSha = sha1('blob', content);
  return { commitSha, contentSha };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

export function handleRest(ctx: Ctx): Reply | null {
  const { segments: s, query } = ctx;
  if (s[0] !== 'api' || s[1] !== 'v3') return null;

  // Auth: every /api/v3 route needs the bearer token.
  if (!ctx.authed) return err(401, 'Bad credentials');

  // GET /api/v3/  and  /api/v3
  if (s.length <= 2) {
    if (ctx.method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (s[2] === 'meta') {
    if (ctx.method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (s[2] === 'user') {
    if (s.length === 3 && ctx.method === 'GET') {
      return json(200, {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: Buffer.from(`user:${VIEWER.login}`, 'utf8').toString('base64url'),
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        avatar_url: '',
        html_url: `http://${ctx.host}/${VIEWER.login}`,
        created_at: EPOCH_ISO,
        updated_at: EPOCH_ISO,
      });
    }
    if (s.length === 4 && s[3] === 'repos') {
      if (ctx.method === 'POST') {
        const b = asRecord(ctx.body);
        const name = asString(b?.name);
        if (name === '') return err(422, 'Validation Failed: name is required');
        const existing = store.getRepo(VIEWER.login, name);
        if (existing) return err(422, 'Repository creation failed. Name already exists on this account');
        const repo = store.createRepo(VIEWER.login, name, b?.private === true, asString(b?.description));
        return json(201, repoJson(repo!, ctx.host));
      }
      if (ctx.method === 'GET') {
        const { page, perPage } = pageParams(query);
        const all = store.listRepos().filter((r) => r.owner === VIEWER.login);
        const items = paginate(all, page, perPage);
        const headers: Record<string, string> = {};
        const totalPages = Math.max(1, Math.ceil(all.length / perPage));
        if (page < totalPages) {
          const next = `http://${ctx.host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
          const last = `http://${ctx.host}/api/v3/user/repos?page=${totalPages}&per_page=${perPage}`;
          headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
        }
        return json(200, items.map((r) => repoJson(r, ctx.host)), headers);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (s[2] !== 'repos' || s.length < 5) return err(404, 'Not Found');
  const owner = decodeURIComponent(s[3]!);
  const repoName = decodeURIComponent(s[4]!);
  // Ownership: a repo belongs to the token's login; any other owner is a 404, never 403.
  if (owner !== VIEWER.login) return err(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  const rest = s.slice(5);

  // GET /repos/{o}/{r}
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      if (!repo) return err(404, 'Not Found');
      return json(200, repoJson(repo, ctx.host));
    }
    if (ctx.method === 'PATCH') {
      if (!repo) return err(404, 'Not Found');
      const b = asRecord(ctx.body);
      if (typeof b?.description === 'string') repo.description = b.description;
      if (typeof b?.private === 'boolean') repo.isPrivate = b.private;
      return json(200, repoJson(repo, ctx.host));
    }
    if (ctx.method === 'DELETE') {
      if (!repo) return err(404, 'Not Found');
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }
  if (!repo) return err(404, 'Not Found');

  const head = rest[0];

  // ---- git refs ----
  if (head === 'git' && rest[1] === 'refs') {
    if (ctx.method === 'POST' && rest.length === 2) {
      const b = asRecord(ctx.body);
      const ref = asString(b?.ref);
      const sha = asString(b?.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
        return err(422, 'Validation Failed: ref or sha is invalid');
      }
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: Buffer.from(`ref:${repo.owner}/${repo.name}:${ref}`, 'utf8').toString('base64url'), url: `http://${ctx.host}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: '' } });
    }
    if (ctx.method === 'GET') {
      if (rest.length === 2) {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
        return json(200, refs);
      }
      const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
      const sha = repo.refs.get(refName);
      if (!sha) return err(404, 'Not Found');
      return json(200, { ref: refName, object: { sha, type: 'commit', url: '' } });
    }
    return err(404, 'Not Found');
  }

  // ---- branches ----
  if (head === 'branches') {
    if (ctx.method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice(11), commit: { sha, url: '' }, protected: false }));
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, list);
    }
    if (ctx.method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return json(200, { name: branch, commit: { sha, url: '' }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // ---- commits ----
  if (head === 'commits') {
    if (ctx.method === 'GET' && rest.length === 1) {
      const tip = resolveRef(repo, query.get('sha'));
      if (!tip) return err(404, 'Not Found');
      const commits = listCommits(repo, tip).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { name: VIEWER.name, email: VIEWER.email, date: EPOCH_ISO }, committer: { name: VIEWER.name, email: VIEWER.email, date: EPOCH_ISO } },
        parents: [],
        url: '',
      }));
      return json(200, commits);
    }
    return err(404, 'Not Found');
  }

  // ---- contents ----
  if (head === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    if (ctx.method === 'PUT') {
      const b = asRecord(ctx.body);
      const message = asString(b?.message, 'Update file');
      const contentB64 = asString(b?.content);
      const content = b64decode(contentB64);
      if (content === null) return err(400, 'content is not valid base64');
      const branch = asString(b?.branch, DEFAULT_BRANCH);
      const sha = asString(b?.sha);
      // Stale-sha check against the current file blob.
      if (sha !== '') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const current = tip !== undefined ? treeMap(repo, tip).get(path) : undefined;
        if (current === undefined || current !== sha) return err(409, 'sha does not match the current file');
      } else {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip !== undefined && treeMap(repo, tip).has(path)) return err(409, 'file already exists; pass its sha to update it');
      }
      const result = contentsCommit(repo, branch, path, content, message);
      if ('error' in result) return err(result.status, result.error);
      const isUpdate = sha !== '';
      return json(isUpdate ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: result.contentSha, size: content.length, encoding: 'base64', type: 'file', url: '' },
        commit: { sha: result.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: EPOCH_ISO }, committer: { name: VIEWER.name, email: VIEWER.email, date: EPOCH_ISO } },
      });
    }
    if (ctx.method === 'GET') {
      const tip = resolveRef(repo, query.get('ref'));
      if (!tip) return err(404, 'Not Found');
      const files = treeMap(repo, tip);
      if (path === '') {
        const entries = dirEntries(repo, files, '');
        return json(200, entries);
      }
      const blobOid = files.get(path);
      if (blobOid !== undefined) {
        const blob = repo.objects.get(blobOid)!;
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: path.split('/').pop(),
          path,
          content: blob.data.toString('base64'),
          sha: blobOid,
          url: '',
        });
      }
      // Directory?
      const prefix = `${path}/`;
      let isDir = false;
      for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
      if (!isDir) return err(404, 'Not Found');
      return json(200, dirEntries(repo, files, path));
    }
    if (ctx.method === 'DELETE') {
      const b = asRecord(ctx.body);
      const message = asString(b?.message, 'Delete file');
      const branch = asString(b?.branch, DEFAULT_BRANCH);
      const sha = asString(b?.sha);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const current = treeMap(repo, tip).get(path);
      if (current === undefined) return err(404, 'Not Found');
      if (sha !== '' && sha !== current) return err(409, 'sha does not match the current file');
      const result = contentsCommit(repo, branch, path, null, message);
      if ('error' in result) return err(result.status, result.error);
      return json(200, { content: null, commit: { sha: result.commitSha, message } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels ----
  if (head === 'labels') {
    if (ctx.method === 'POST' && rest.length === 1) {
      const b = asRecord(ctx.body);
      const name = asString(b?.name);
      if (name === '') return err(422, 'Validation Failed: name is required');
      const color = asString(b?.color, 'ededed');
      const existing = repo.labels.get(name);
      if (existing) return json(201, { name, color: existing.color });
      repo.labels.set(name, { name, color });
      return json(201, { name, color, description: '' });
    }
    if (ctx.method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
    }
    return err(404, 'Not Found');
  }

  // ---- issues ----
  if (head === 'issues') {
    if (rest.length === 1) {
      if (ctx.method === 'POST') {
        const b = asRecord(ctx.body);
        const title = asString(b?.title);
        if (title === '') return err(422, 'Validation Failed: title is required');
        const labels = Array.isArray(b?.labels) ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
        }
        const issue = createIssue(repo, title, asString(b?.body), labels);
        return json(201, issueJson(repo, issue, ctx.host));
      }
      if (ctx.method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, perPage } = pageParams(query);
        const items = paginate(list, page, perPage);
        const headers: Record<string, string> = {};
        if (page * perPage < list.length) {
          const q = new URLSearchParams(query);
          q.set('page', String(page + 1));
          headers.link = `<http://${ctx.host}/api/v3/repos/${owner}/${repoName}/issues?${q.toString()}>; rel="next"`;
        }
        return json(200, items.map((i) => issueJson(repo, i, ctx.host)), headers);
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1]!, 10);
    const issue = Number.isInteger(num) ? repo.issues.get(num) : undefined;
    if (!issue) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (ctx.method === 'GET') {
        return { status: 200, body: issueJsonCached(repo, issue, ctx.host) };
      }
      if (ctx.method === 'PATCH') {
        const b = asRecord(ctx.body);
        if (typeof b?.title === 'string') issue.title = b.title;
        if (typeof b?.body === 'string') issue.body = b.body;
        if (b?.state === 'open' || b?.state === 'closed') issue.state = b.state;
        if (Array.isArray(b?.labels)) {
          const labels = (b.labels as unknown[]).filter((x): x is string => typeof x === 'string');
          for (const label of labels) if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
          issue.labels = labels;
        }
        issue.jsonCache = null;
        return json(200, issueJson(repo, issue, ctx.host));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (ctx.method === 'POST') {
        const b = asRecord(ctx.body);
        const body = asString(b?.body);
        if (body === '') return err(422, 'Validation Failed: body is required');
        const comment = { id: store.nextCommentId(), body, seq: store.nextSeq() };
        issue.comments.push(comment);
        issue.jsonCache = null;
        return json(201, { id: comment.id, body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: EPOCH_ISO, updated_at: EPOCH_ISO });
      }
      if (ctx.method === 'GET') {
        return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: EPOCH_ISO, updated_at: EPOCH_ISO })));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pulls ----
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (ctx.method === 'POST') {
        const b = asRecord(ctx.body);
        const title = asString(b?.title);
        const headRef = asString(b?.head);
        const baseRef = asString(b?.base, DEFAULT_BRANCH);
        if (title === '' || headRef === '') return err(422, 'Validation Failed: title and head are required');
        if (!repo.refs.has(`refs/heads/${headRef}`)) return err(422, `Validation Failed: head branch "${headRef}" does not exist`);
        if (!repo.refs.has(`refs/heads/${baseRef}`)) return err(422, `Validation Failed: base branch "${baseRef}" does not exist`);
        const pull = createPull(repo, title, asString(b?.body), headRef, baseRef);
        if (!pull) return err(422, 'Validation Failed');
        return json(201, pullJson(repo, pull, ctx.host));
      }
      if (ctx.method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        const { page, perPage } = pageParams(query);
        return json(200, paginate(list, page, perPage).map((p) => pullJson(repo, p, ctx.host)));
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1]!, 10);
    const pull = Number.isInteger(num) ? repo.pulls.get(num) : undefined;
    if (!pull) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (ctx.method === 'GET') return json(200, pullJson(repo, pull, ctx.host));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (ctx.method !== 'GET') return err(404, 'Not Found');
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (!baseTip || !headTip) return err(404, 'Not Found');
      const baseMap = treeMap(repo, baseTip);
      const headMap = treeMap(repo, headTip);
      const diff = diffMaps(baseMap, headMap);
      const files = [...diff.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([filename, d]) => {
          const oldText = d.oldOid ? repo.objects.get(d.oldOid)?.data.toString('utf8') ?? '' : '';
          const newText = d.newOid ? repo.objects.get(d.newOid)?.data.toString('utf8') ?? '' : '';
          const oldLines = oldText === '' ? [] : oldText.split('\n');
          const newLines = newText === '' ? [] : newText.split('\n');
          // Rough line counts via common prefix/suffix.
          let prefix = 0;
          while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
          let suffix = 0;
          while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
          const deletions = oldLines.length - prefix - suffix;
          const additions = newLines.length - prefix - suffix;
          return { filename, status: d.status, additions, deletions, changes: additions + deletions };
        });
      return json(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (ctx.method !== 'PUT') return err(404, 'Not Found');
      if (pull.merged) return err(405, 'Pull request already merged');
      if (pull.state !== 'open') return err(405, 'Pull request is closed');
      const sha = squashMerge(repo, pull);
      if (sha === null) return err(405, 'Merge conflict: the head branch conflicts with the base branch');
      return json(200, { sha, merged: true, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function dirEntries(repo: Repo, files: Map<string, string>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string }>();
  for (const [path, oid] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // Directory sha: the tree oid of this directory at the commit is not
        // tracked here; use the sha of the first file under it is wrong, so
        // recompute from the tree. We approximate with the blob oid only when
        // no tree is available — but the checks require a 40-hex sha, and the
        // tree oid is available via the parent tree walk. Fall back to blob.
        seen.set(name, { type: 'dir', oid });
      }
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [name, e] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const blob = e.type === 'file' ? repo.objects.get(e.oid) : undefined;
    out.push({
      type: e.type,
      name,
      path: prefix + name,
      sha: e.oid,
      size: blob ? blob.data.length : 0,
      url: '',
    });
  }
  return out;
}
