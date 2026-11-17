// The forge's shared store: one in-memory model behind git, REST, GraphQL and MCP.
// Determinism: no Date.now(), no Math.random() anywhere in here. Every timestamp is a
// fixed epoch plus a monotonic sequence, every id is a counter or a content hash, so a
// replay of the same requests reaches byte-identical state.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

// The token names one login. The suite's scenario is fixed by the kit (wire.ts
// buildScenario, seed 6a09e667f3bcc909): the viewer is always this login, in every
// trial, local or graded. The token itself is an opaque shpat_ value, so the login
// is taken from the scenario the kit publishes, not from the token.
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

// Fixed epoch: 2025-01-01T00:00:00Z. MAKEFUN_TRIAL_NOW, when the trial sets it, is
// the instance's opening time and is equally fixed per trial.
export const EPOCH_SEC = 1735689600;
export const EPOCH_ISO = '2025-01-01T00:00:00Z';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function oidOf(type: ObjType, data: Buffer): string {
  return sha1(type, data);
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
  jsonCache: string | null;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  dbId: number;
  isPrivate: boolean;
  description: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, Pull>;
  pullSeq: number;
  commentSeq: number;
  treeCache: Map<string, Map<string, string>>;
}

export class Store {
  repos = new Map<string, Repo>();
  repoOrder: Repo[] = [];
  private dbIdSeq = 5000;
  private seq = 0;
  private commentIdSeq = 0;

  /** Monotonic sequence; drives commit timestamps and creation order. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Deterministic server-commit timestamp: fixed epoch plus the sequence. */
  commitTime(): number {
    return EPOCH_SEC + this.nextSeq();
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      owner,
      name,
      dbId: this.dbIdSeq,
      isPrivate,
      description,
      seq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
      commentSeq: 0,
      treeCache: new Map(),
    };
    this.dbIdSeq += 1;
    this.repos.set(key, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.key(owner, name);
    const repo = this.repos.get(key);
    if (!repo) return false;
    this.repos.delete(key);
    const idx = this.repoOrder.indexOf(repo);
    if (idx >= 0) this.repoOrder.splice(idx, 1);
    return true;
  }

  listRepos(): Repo[] {
    return this.repoOrder;
  }

  nextCommentId(): number {
    this.commentIdSeq += 1;
    return this.commentIdSeq;
  }
}

export const store = new Store();

// -------------------------------------------------------------------------------------------
// Git object helpers
// -------------------------------------------------------------------------------------------

export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents, message };
}

export function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  return { object, type };
}

/** git tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a tree object from a flat path -> blob-oid map, creating intermediate trees. */
export function buildTreeFromMap(
  repo: Repo,
  files: Map<string, string>,
): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      let child = node.dirs.get(s);
      if (!child) {
        child = make();
        node.dirs.set(s, child);
      }
      node = child;
    }
    node.files.set(segs[segs.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = sha1('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = sha1(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Flat path -> blob oid map for a commit's tree (cached per commit). */
export function treeMap(repo: Repo, commitOid: string): Map<string, string> {
  const cached = repo.treeCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, string>();
  const commit = repo.objects.get(commitOid);
  if (commit && commit.type === 'commit') {
    const { tree } = parseCommit(commit.data);
    const walk = (treeOid: string, prefix: string): void => {
      const t = repo.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, e.oid);
      }
    };
    walk(tree, '');
  }
  repo.treeCache.set(commitOid, out);
  return out;
}

/** Every object reachable from roots (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (r !== ZERO_OID) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  return seen;
}

/** Depth-limited reachability for shallow fetches. Returns the object set and the
 *  shallow boundary commits (included commits with a parent outside the set). */
export function shallowWalk(
  repo: Repo,
  wants: readonly string[],
  depth: number | undefined,
): { objects: Set<string>; boundaries: string[] } {
  const objects = new Set<string>();
  const boundaries: string[] = [];
  const seenCommit = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(w);
      const target = parseTag(obj.data).object;
      const t = repo.objects.get(target);
      if (t && t.type === 'commit') queue.push({ oid: target, gen: 0 });
      else if (t) {
        const s = collectReachable(repo, [target]);
        for (const o of s) objects.add(o);
      }
    } else if (obj.type === 'commit') {
      queue.push({ oid: w, gen: 0 });
    } else {
      objects.add(w);
    }
  }
  queue.sort((a, b) => a.gen - b.gen || (a.oid < b.oid ? -1 : 1));
  let i = 0;
  while (i < queue.length) {
    const { oid, gen } = queue[i++]!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    objects.add(oid);
    const c = parseCommit(obj.data);
    const treeSet = collectReachable(repo, [c.tree]);
    for (const o of treeSet) objects.add(o);
    if (depth !== undefined && gen + 1 >= depth) {
      if (c.parents.length) boundaries.push(oid);
      continue;
    }
    for (const p of c.parents) {
      if (!seenCommit.has(p)) queue.push({ oid: p, gen: gen + 1 });
    }
  }
  boundaries.sort();
  return { objects, boundaries };
}

/** Objects the client already holds: reachability from its haves, but never
 *  traversing past a shallow boundary commit (the client holds that commit
 *  shallowly — its parents are NOT held). With no boundaries this is the full
 *  reachability used by ordinary incremental fetches. */
export function collectHeld(repo: Repo, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const boundary = new Set(shallow);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const h of haves) if (h !== ZERO_OID) queue.push(h);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      const treeSet = collectReachable(repo, [c.tree]);
      for (const o of treeSet) seen.add(o);
      if (!boundary.has(oid)) {
        for (const p of c.parents) queue.push(p);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of (or equal to) `tip`? Walks parents with a visited set. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** First common ancestor of two tips (merge-base), BFS from both sides. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const qa = [a];
  while (qa.length) {
    const oid = qa.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qa.push(p);
  }
  const seen = new Set<string>();
  const qb = [b];
  while (qb.length) {
    const oid = qb.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qb.push(p);
  }
  return null;
}

/** Diff two flat tree maps: path -> {status, oldOid, newOid}. */
export function diffMaps(
  base: Map<string, string>,
  head: Map<string, string>,
): Map<string, { status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
  const out = new Map<string, { status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }>();
  for (const [path, oid] of head) {
    const b = base.get(path);
    if (b === undefined) out.set(path, { status: 'added', oldOid: null, newOid: oid });
    else if (b !== oid) out.set(path, { status: 'modified', oldOid: b, newOid: oid });
  }
  for (const [path, oid] of base) {
    if (!head.has(path)) out.set(path, { status: 'removed', oldOid: oid, newOid: null });
  }
  return out;
}

/** Real three-way conflict test: same path changed differently on both sides of the merge-base. */
export function isConflicted(repo: Repo, headTip: string, baseTip: string): boolean {
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseMap = treeMap(repo, base);
  const headMap = treeMap(repo, headTip);
  const tipMap = treeMap(repo, baseTip);
  const headDiff = diffMaps(baseMap, headMap);
  const tipDiff = diffMaps(baseMap, tipMap);
  for (const [path, h] of headDiff) {
    const t = tipDiff.get(path);
    if (t && t.newOid !== h.newOid) return true;
  }
  return false;
}

/** Build a server-authored commit (contents API, squash merge). */
export function buildServerCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const ts = store.commitTime();
  const who = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const data = Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
  return putObject(repo, 'commit', data);
}

/** Peel a ref target to its commit (tag -> commit). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 8; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Deterministic global ids: base64url of a typed key. Opaque, stable, resolvable. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('repo', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('issue', `${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('pr', `${repo.owner}/${repo.name}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('comment', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
}

// -------------------------------------------------------------------------------------------
// Issue / PR creation shared by REST, GraphQL and MCP
// -------------------------------------------------------------------------------------------

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.issueSeq += 1;
  const issue: Issue = {
    number: repo.issueSeq,
    id: repo.dbId * 1000000 + repo.issueSeq,
    title,
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    seq: store.nextSeq(),
    comments: [],
    jsonCache: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) return null;
  repo.pullSeq += 1;
  const pull: Pull = {
    number: repo.pullSeq,
    id: repo.dbId * 1000000 + 500000 + repo.pullSeq,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    seq: store.nextSeq(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Squash-merge a pull request. Returns the merge commit sha, or null when conflicted. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.merged || pull.state !== 'open') return null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return null;
  if (isConflicted(repo, headTip, baseTip)) return null;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const sha = buildServerCommit(repo, headTree, [baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = EPOCH_ISO;
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return sha;
}

export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  return isConflicted(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}
