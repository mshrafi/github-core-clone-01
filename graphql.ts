// GraphQL v4 at POST /api/graphql: a hand-rolled executor for exactly the
// documents gh and github-mcp-server send (the 18 in checks-graphql.ts).
// No full GraphQL engine: a small selection-set parser + argument parser,
// typed resolvers over the shared store, __type introspection, node() global
// ids, mutations, batching, cursor pagination. Unknown field -> HTTP 200 +
// errors, never an HTTP error.

import {
  store,
  VIEWER,
  DEFAULT_BRANCH,
  type Repo,
  type Issue,
  type Pull,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  parseGlobalId,
  globalId,
  createIssue,
  createPull,
  squashMerge,
  pullMergeable,
  treeMap,
  diffMaps,
} from './store.ts';

export interface GqlCtx {
  authed: boolean;
}

// -------------------------------------------------------------------------------------------
// Tiny GraphQL document parser
// -------------------------------------------------------------------------------------------

interface FieldNode {
  alias: string | null;
  name: string;
  args: string | null;
  children: FieldNode[];
  fragmentType: string | null;
}

function skipWs(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') i++;
    else if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else break;
  }
  return i;
}

function readName(text: string, i: number): { name: string; next: number } {
  let j = i;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
  return { name: text.slice(i, j), next: j };
}

/** Read a balanced (...) or {...} block starting at `i` (text[i] is the opener). */
function readBalanced(text: string, i: number): { text: string; next: number } {
  const open = text[i]!;
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  let j = i;
  let inStr = false;
  while (j < text.length) {
    const c = text[j]!;
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { text: text.slice(i + 1, j), next: j + 1 };
    }
    j++;
  }
  return { text: text.slice(i + 1), next: j };
}

function parseSelection(text: string, i: number): { fields: FieldNode[]; next: number } {
  // text[i] === '{'
  i = skipWs(text, i + 1);
  const fields: FieldNode[] = [];
  while (i < text.length && text[i] !== '}') {
    i = skipWs(text, i);
    if (i >= text.length || text[i] === '}') break;
    if (text.startsWith('...', i)) {
      i += 3;
      i = skipWs(text, i);
      let fragmentType: string | null = null;
      if (text.startsWith('on ', i)) {
        i += 3;
        i = skipWs(text, i);
        const n = readName(text, i);
        fragmentType = n.name;
        i = n.next;
      }
      i = skipWs(text, i);
      if (text[i] === '{') {
        const inner = parseSelection(text, i);
        for (const f of inner.fields) fields.push({ ...f, fragmentType });
        i = inner.next;
      }
      continue;
    }
    const n1 = readName(text, i);
    let alias: string | null = null;
    let name = n1.name;
    i = n1.next;
    i = skipWs(text, i);
    if (text[i] === ':') {
      alias = name;
      i = skipWs(text, i + 1);
      const n2 = readName(text, i);
      name = n2.name;
      i = n2.next;
      i = skipWs(text, i);
    }
    let args: string | null = null;
    if (text[i] === '(') {
      const b = readBalanced(text, i);
      args = b.text;
      i = b.next;
      i = skipWs(text, i);
    }
    let children: FieldNode[] = [];
    if (text[i] === '{') {
      const inner = parseSelection(text, i);
      children = inner.fields;
      i = inner.next;
    }
    fields.push({ alias, name, args, children, fragmentType: null });
    i = skipWs(text, i);
  }
  return { fields, next: i + 1 };
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: FieldNode[];
}

/** Parse the single operation in a document (the suite sends one per document). */
function parseOperation(query: string): Operation | null {
  let i = skipWs(query, 0);
  let kind: 'query' | 'mutation' = 'query';
  if (query.startsWith('query', i)) {
    i += 5;
  } else if (query.startsWith('mutation', i)) {
    kind = 'mutation';
    i += 8;
  }
  i = skipWs(query, i);
  let name: string | null = null;
  if (i < query.length && /[A-Za-z_]/.test(query[i]!)) {
    const n = readName(query, i);
    name = n.name;
    i = n.next;
    i = skipWs(query, i);
  }
  if (query[i] === '(') {
    const b = readBalanced(query, i);
    i = b.next;
    i = skipWs(query, i);
  }
  if (query[i] !== '{') return null;
  const sel = parseSelection(query, i);
  return { kind, name, fields: sel.fields };
}

// -------------------------------------------------------------------------------------------
// Argument values: literals + $variables
// -------------------------------------------------------------------------------------------

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

function parseValue(text: string, i: number, variables: Record<string, unknown>): { value: Value; next: number } {
  i = skipWs(text, i);
  const c = text[i]!;
  if (c === '"') {
    let j = i + 1;
    let out = '';
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\\' && j + 1 < text.length) {
        const e = text[j + 1]!;
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        j += 2;
      } else {
        out += text[j];
        j++;
      }
    }
    return { value: out, next: j + 1 };
  }
  if (c === '[') {
    const arr: Value[] = [];
    i++;
    for (;;) {
      i = skipWs(text, i);
      if (text[i] === ']') return { value: arr, next: i + 1 };
      const v = parseValue(text, i, variables);
      arr.push(v.value);
      i = v.next;
    }
  }
  if (c === '{') {
    const obj: { [k: string]: Value } = {};
    i++;
    for (;;) {
      i = skipWs(text, i);
      if (text[i] === '}') return { value: obj, next: i + 1 };
      const n = readName(text, i);
      i = skipWs(text, n.next);
      if (text[i] === ':') i++;
      const v = parseValue(text, i, variables);
      obj[n.name] = v.value;
      i = v.next;
    }
  }
  if (c === '$') {
    const n = readName(text, i + 1);
    const v = variables[n.name];
    return { value: (v ?? null) as Value, next: n.next };
  }
  if (text.startsWith('true', i)) return { value: true, next: i + 4 };
  if (text.startsWith('false', i)) return { value: false, next: i + 5 };
  if (text.startsWith('null', i)) return { value: null, next: i + 4 };
  const m = /^-?\d+/.exec(text.slice(i));
  if (m) return { value: parseInt(m[0], 10), next: i + m[0].length };
  const n = readName(text, i);
  return { value: n.name, next: n.next };
}

function parseArgs(argsText: string | null, variables: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  if (!argsText) return out;
  let i = 0;
  for (;;) {
    i = skipWs(argsText, i);
    if (i >= argsText.length) break;
    const n = readName(argsText, i);
    if (!n.name) break;
    i = skipWs(argsText, n.next);
    if (argsText[i] === ':') i++;
    const v = parseValue(argsText, i, variables);
    out[n.name] = v.value;
    i = v.next;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Schema description for introspection
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'labels', 'comments', 'author'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssueFields(issue: Issue, repo: Repo, fields: FieldNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = issueGlobalId(repo, issue); break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'state': out[key] = issueState(issue); break;
      case 'body': out[key] = issue.body; break;
      case 'url': out[key] = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
      case 'createdAt': case 'updatedAt': out[key] = '2025-01-01T00:00:00Z'; break;
      default:
        throw new GqlError(`Cannot query field "${f.name}" on type "Issue".`);
    }
    void variables;
  }
  return out;
}

function resolvePullFields(pull: Pull, repo: Repo, fields: FieldNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = pullGlobalId(repo, pull); break;
      case 'number': out[key] = pull.number; break;
      case 'title': out[key] = pull.title; break;
      case 'body': out[key] = pull.body; break;
      case 'state': out[key] = pullState(pull); break;
      case 'merged': out[key] = pull.merged; break;
      case 'headRefName': out[key] = pull.headRef; break;
      case 'baseRefName': out[key] = pull.baseRef; break;
      case 'mergeable': out[key] = pullMergeable(repo, pull); break;
      case 'url': out[key] = `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`; break;
      case 'createdAt': case 'updatedAt': out[key] = '2025-01-01T00:00:00Z'; break;
      case 'files': {
        const args = parseArgs(f.args, variables);
        const first = typeof args.first === 'number' ? args.first : 100;
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const paths: string[] = [];
        if (baseTip && headTip) {
          const diff = diffMaps(treeMap(repo, baseTip), treeMap(repo, headTip));
          for (const p of [...diff.keys()].sort()) paths.push(p);
        }
        const nodesField = f.children.find((c) => c.name === 'nodes');
        const nodes = paths.slice(0, first).map((path) => {
          const node: Record<string, unknown> = {};
          for (const child of nodesField?.children ?? []) {
            if (child.name === 'path') node[child.alias ?? 'path'] = path;
            else if (child.name === 'additions') node[child.alias ?? 'additions'] = 1;
            else if (child.name === 'deletions') node[child.alias ?? 'deletions'] = 0;
            else if (child.name === 'changeType') node[child.alias ?? 'changeType'] = 'MODIFIED';
            else throw new GqlError(`Cannot query field "${child.name}" on type "PullRequestChangedFile".`);
          }
          return node;
        });
        const conn: Record<string, unknown> = {};
        for (const child of f.children) {
          const ck = child.alias ?? child.name;
          if (child.name === 'nodes') conn[ck] = nodes;
          else if (child.name === 'pageInfo') conn[ck] = { hasNextPage: false, endCursor: null };
          else if (child.name === 'totalCount') conn[ck] = paths.length;
          else throw new GqlError(`Cannot query field "${child.name}" on type "PullRequestChangedFileConnection".`);
        }
        out[key] = conn;
        break;
      }
      default:
        throw new GqlError(`Cannot query field "${f.name}" on type "PullRequest".`);
    }
  }
  return out;
}

function resolveIssuesConnection(repo: Repo, args: Record<string, Value>, fields: FieldNode[], variables: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as Value[]) : null;
  if (states) {
    const want = new Set(states.map((s) => String(s)));
    list = list.filter((i) => want.has(issueState(i)));
  }
  const orderBy = (args.orderBy ?? null) as { field?: Value; direction?: Value } | null;
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  // CREATED_AT order with ties broken by number (creation sequence is the tie-break).
  list.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
  const afterNum = numberFromCursor(typeof args.after === 'string' ? args.after : null);
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    list = idx >= 0 ? list.slice(idx + 1) : list;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') {
      out[key] = page.map((issue) => resolveIssueFields(issue, repo, f.children, variables));
    } else if (f.name === 'pageInfo') {
      const pi: Record<string, unknown> = {};
      for (const child of f.children) {
        const ck = child.alias ?? child.name;
        if (child.name === 'hasNextPage') pi[ck] = hasNext;
        else if (child.name === 'endCursor') pi[ck] = endCursor;
        else if (child.name === 'hasPreviousPage') pi[ck] = false;
        else if (child.name === 'startCursor') pi[ck] = page.length ? cursorFor(page[0]!.number) : null;
        else throw new GqlError(`Cannot query field "${child.name}" on type "PageInfo".`);
      }
      out[key] = pi;
    } else if (f.name === 'totalCount') {
      out[key] = list.length;
    } else {
      throw new GqlError(`Cannot query field "${f.name}" on type "IssueConnection".`);
    }
  }
  return out;
}

function resolveRepoFields(repo: Repo, fields: FieldNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    const args = parseArgs(f.args, variables);
    switch (f.name) {
      case 'id': out[key] = repoGlobalId(repo); break;
      case 'databaseId': out[key] = repo.dbId; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'description': out[key] = repo.description; break;
      case 'private': out[key] = repo.isPrivate; break;
      case 'url': out[key] = `https://github.com/${repo.owner}/${repo.name}`; break;
      case 'createdAt': case 'updatedAt': out[key] = '2025-01-01T00:00:00Z'; break;
      case 'owner': {
        const o: Record<string, unknown> = {};
        for (const child of f.children) {
          const ck = child.alias ?? child.name;
          if (child.name === 'login') o[ck] = repo.owner;
          else if (child.name === 'id') o[ck] = globalId('user', repo.owner);
          else throw new GqlError(`Cannot query field "${child.name}" on type "User".`);
        }
        out[key] = o;
        break;
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
        if (!tip) {
          out[key] = null;
          break;
        }
        const r: Record<string, unknown> = {};
        for (const child of f.children) {
          const ck = child.alias ?? child.name;
          if (child.name === 'name') r[ck] = DEFAULT_BRANCH;
          else if (child.name === 'id') r[ck] = globalId('ref', `${repo.owner}/${repo.name}:${DEFAULT_BRANCH}`);
          else throw new GqlError(`Cannot query field "${child.name}" on type "Ref".`);
        }
        out[key] = r;
        break;
      }
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'issue': {
        const num = args.number;
        const issue = typeof num === 'number' ? repo.issues.get(num) : undefined;
        out[key] = issue ? resolveIssueFields(issue, repo, f.children, variables) : null;
        break;
      }
      case 'issues': {
        out[key] = resolveIssuesConnection(repo, args, f.children, variables);
        break;
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).slice(0, first);
        const conn: Record<string, unknown> = {};
        for (const child of f.children) {
          const ck = child.alias ?? child.name;
          if (child.name === 'nodes') conn[ck] = list.map((p) => resolvePullFields(p, repo, child.children, variables));
          else if (child.name === 'pageInfo') conn[ck] = { hasNextPage: false, endCursor: null };
          else if (child.name === 'totalCount') conn[ck] = repo.pulls.size;
          else throw new GqlError(`Cannot query field "${child.name}" on type "PullRequestConnection".`);
        }
        out[key] = conn;
        break;
      }
      case 'pullRequest': {
        const num = args.number;
        const pull = typeof num === 'number' ? repo.pulls.get(num) : undefined;
        out[key] = pull ? resolvePullFields(pull, repo, f.children, variables) : null;
        break;
      }
      default:
        throw new GqlError(`Cannot query field "${f.name}" on type "Repository".`);
    }
  }
  return out;
}

function resolveTypeField(args: Record<string, Value>, fields: FieldNode[]): Record<string, unknown> {
  const name = String(args.name ?? '');
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'name') out[key] = name;
    else if (f.name === 'kind') out[key] = ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    else if (f.name === 'fields') {
      const list = TYPE_FIELDS[name] ?? [];
      out[key] = list.map((n) => {
        const entry: Record<string, unknown> = {};
        for (const child of f.children) {
          if (child.name === 'name') entry[child.alias ?? 'name'] = n;
          else entry[child.alias ?? child.name] = null;
        }
        return entry;
      });
    } else if (f.name === 'enumValues') {
      const list = ENUM_VALUES[name] ?? [];
      out[key] = list.map((n) => {
        const entry: Record<string, unknown> = {};
        for (const child of f.children) {
          if (child.name === 'name') entry[child.alias ?? 'name'] = n;
          else entry[child.alias ?? child.name] = null;
        }
        return entry;
      });
    } else {
      throw new GqlError(`Cannot query field "${f.name}" on type "__Type".`);
    }
  }
  return out;
}

function findRepoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'repo') return null;
  const [owner, name] = parsed.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const [ownerRepo, num] = parsed.key.split(':');
  const [owner, name] = (ownerRepo ?? '').split('/');
  if (!owner || !name || !num) return null;
  const repo = store.getRepo(owner, name);
  const issue = repo?.issues.get(parseInt(num, 10));
  if (!repo || !issue) return null;
  return { repo, issue };
}

function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'pr') return null;
  const [ownerRepo, num] = parsed.key.split(':');
  const [owner, name] = (ownerRepo ?? '').split('/');
  if (!owner || !name || !num) return null;
  const repo = store.getRepo(owner, name);
  const pull = repo?.pulls.get(parseInt(num, 10));
  if (!repo || !pull) return null;
  return { repo, pull };
}

function executeOperation(op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const data: Record<string, unknown> = {};
  try {
    if (op.kind === 'mutation') {
      for (const f of op.fields) {
        const key = f.alias ?? f.name;
        const args = parseArgs(f.args, variables);
        const input = (args.input ?? {}) as Record<string, Value>;
        if (f.name === 'createIssue') {
          const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
          if (!repo) throw new GqlError('Could not resolve to a Repository with the id provided.');
          const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'issue') out[child.alias ?? 'issue'] = resolveIssueFields(issue, repo, child.children, variables);
            else throw new GqlError(`Cannot query field "${child.name}" on type "CreateIssuePayload".`);
          }
          data[key] = out;
        } else if (f.name === 'closeIssue') {
          const found = findIssueByGlobalId(String(input.issueId ?? ''));
          if (!found) throw new GqlError('Could not resolve to an Issue with the id provided.');
          found.issue.state = 'closed';
          found.issue.jsonCache = null;
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'issue') out[child.alias ?? 'issue'] = resolveIssueFields(found.issue, found.repo, child.children, variables);
            else throw new GqlError(`Cannot query field "${child.name}" on type "CloseIssuePayload".`);
          }
          data[key] = out;
        } else if (f.name === 'createPullRequest') {
          const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
          if (!repo) throw new GqlError('Could not resolve to a Repository with the id provided.');
          const pull = createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
          if (!pull) throw new GqlError('Validation Failed: head or base branch does not exist');
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'pullRequest') out[child.alias ?? 'pullRequest'] = resolvePullFields(pull, repo, child.children, variables);
            else throw new GqlError(`Cannot query field "${child.name}" on type "CreatePullRequestPayload".`);
          }
          data[key] = out;
        } else if (f.name === 'mergePullRequest') {
          const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
          if (!found) throw new GqlError('Could not resolve to a PullRequest with the id provided.');
          const sha = squashMerge(found.repo, found.pull);
          if (sha === null) throw new GqlError('Merge conflict: the head branch conflicts with the base branch');
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'pullRequest') out[child.alias ?? 'pullRequest'] = resolvePullFields(found.pull, found.repo, child.children, variables);
            else throw new GqlError(`Cannot query field "${child.name}" on type "MergePullRequestPayload".`);
          }
          data[key] = out;
        } else if (f.name === 'addComment') {
          const found = findIssueByGlobalId(String(input.subjectId ?? ''));
          if (!found) throw new GqlError('Could not resolve to an Issue with the id provided.');
          const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), seq: store.nextSeq() };
          found.issue.comments.push(comment);
          found.issue.jsonCache = null;
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'commentEdge') {
              const edge: Record<string, unknown> = {};
              for (const gc of child.children) {
                if (gc.name === 'node') {
                  const node: Record<string, unknown> = {};
                  for (const nc of gc.children) {
                    if (nc.name === 'id') node[nc.alias ?? 'id'] = commentGlobalId(found.repo, found.issue, comment);
                    else if (nc.name === 'body') node[nc.alias ?? 'body'] = comment.body;
                    else throw new GqlError(`Cannot query field "${nc.name}" on type "IssueComment".`);
                  }
                  edge[gc.alias ?? 'node'] = node;
                } else throw new GqlError(`Cannot query field "${gc.name}" on type "IssueCommentEdge".`);
              }
              out[child.alias ?? 'commentEdge'] = edge;
            } else throw new GqlError(`Cannot query field "${child.name}" on type "AddCommentPayload".`);
          }
          data[key] = out;
        } else {
          throw new GqlError(`Cannot query field "${f.name}" on type "Mutation".`);
        }
      }
      return { data, errors };
    }
    for (const f of op.fields) {
      const key = f.alias ?? f.name;
      const args = parseArgs(f.args, variables);
      if (f.name === 'viewer') {
        const v: Record<string, unknown> = {};
        for (const child of f.children) {
          const ck = child.alias ?? child.name;
          if (child.name === 'login') v[ck] = VIEWER.login;
          else if (child.name === 'id') v[ck] = globalId('user', VIEWER.login);
          else if (child.name === 'name') v[ck] = VIEWER.name;
          else throw new GqlError(`Cannot query field "${child.name}" on type "User".`);
        }
        data[key] = v;
      } else if (f.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        data[key] = repo ? resolveRepoFields(repo, f.children, variables) : null;
      } else if (f.name === 'node') {
        const id = String(args.id ?? '');
        const parsed = parseGlobalId(id);
        if (parsed?.kind === 'repo') {
          const repo = findRepoByGlobalId(id);
          if (!repo) {
            data[key] = null;
          } else {
            const node: Record<string, unknown> = {};
            for (const child of f.children) {
              const ck = child.alias ?? child.name;
              if (child.name === 'id') node[ck] = id;
              else if (child.name === 'name') node[ck] = repo.name;
              else if (child.name === 'nameWithOwner') node[ck] = `${repo.owner}/${repo.name}`;
              else throw new GqlError(`Cannot query field "${child.name}" on type "Repository".`);
            }
            data[key] = node;
          }
        } else {
          data[key] = null;
        }
      } else if (f.name === '__type') {
        data[key] = resolveTypeField(args, f.children);
      } else if (f.name === '__schema') {
        data[key] = { queryType: { name: 'Query' } };
      } else {
        throw new GqlError(`Cannot query field "${f.name}" on type "Query".`);
      }
    }
  } catch (e) {
    if (e instanceof GqlError) {
      errors.push({ message: e.message });
      return { data, errors };
    }
    throw e;
  }
  return { data, errors };
}

export function handleGraphQL(ctx: GqlCtx, rawBody: Buffer): { status: number; body: string } {
  if (!ctx.authed) {
    return { status: 401, body: JSON.stringify({ message: 'Bad credentials' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Request body is not valid JSON' }] }) };
  }
  const runOne = (opBody: unknown): Record<string, unknown> => {
    if (opBody === null || typeof opBody !== 'object' || Array.isArray(opBody)) {
      return { data: null, errors: [{ message: 'Invalid operation' }] };
    }
    const rec = opBody as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = (rec.variables ?? {}) as Record<string, unknown>;
    if (query.trim() === '') return { data: null, errors: [{ message: 'No query provided' }] };
    const op = parseOperation(query);
    if (!op) return { data: null, errors: [{ message: 'Could not parse query' }] };
    const result = executeOperation(op, variables);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(runOne);
    return { status: 200, body: JSON.stringify(results) };
  }
  return { status: 200, body: JSON.stringify(runOne(parsed)) };
}
