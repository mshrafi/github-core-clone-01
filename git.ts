// Git smart HTTP: pkt-line codec, pack reader/writer (plain objects, no deltas on
// the wire out; deltas in are resolved), v2 upload-pack (ls-refs/fetch), v0
// receive-pack, v0 advertisements. SHA-1 only.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  store,
  ZERO_OID,
  DEFAULT_BRANCH,
  type GitObject,
  type ObjType,
  type Repo,
  sha1,
  parseTree,
  parseCommit,
  parseTag,
  collectReachable,
  collectHeld,
  shallowWalk,
  isAncestor,
  putObject,
} from './store.ts';

export const AGENT = 'forge/1.0';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream. Throws on malformed input. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (hex === '0002') {
      out.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

export function pktDataLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const p of decodePktLines(buf)) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// Pack writer (plain objects) and reader (incl. OFS/REF deltas)
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size) first |= 0x80;
  bytes.push(first);
  while (size) {
    let b = size & 0x7f;
    size >>= 7;
    if (size) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  const hash = createHash('sha1');
  hash.update(head);
  for (const obj of sorted) {
    const header = packEntryHeader(obj.type, obj.data.length);
    const deflated = deflateSync(obj.data, { level: 6 });
    const entry = Buffer.concat([header, deflated]);
    parts.push(entry);
    hash.update(entry);
  }
  const trailer = hash.digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOff += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile; resolve deltas against pack entries and `resolveBase` (thin packs). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const header = readVarint(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off++]!;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++]!;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: Raw, seen: Set<number>): { type: ObjType; data: Buffer } => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      if (seen.has(entry.offset)) throw new Error('delta cycle');
      seen.add(entry.offset);
      let base: { type: ObjType; data: Buffer };
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry, seen);
      } else {
        const baseObj = resolveBase?.(entry.baseOid!);
        if (baseObj) {
          base = baseObj;
        } else {
          const found = [...objects.values()].find(() => false);
          void found;
          throw new Error('ref-delta base missing');
        }
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: CODE_TYPE[entry.typeCode]!, data: entry.data };
  };
  // Resolve deltas in two passes: first non-deltas (so ref-delta bases inside the
  // pack are available via objects map), then deltas. OFS bases are resolved
  // recursively through `resolve`, which also handles chains.
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) continue;
    const type = CODE_TYPE[entry.typeCode]!;
    const oid = sha1(type, entry.data);
    objects.set(oid, { type, data: entry.data });
  }
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) continue;
    let base: { type: ObjType; data: Buffer };
    if (entry.typeCode === 6) {
      base = resolve(byOffset.get(entry.baseOffset!)!, new Set([entry.offset]));
    } else {
      const inPack = [...objects.entries()].find(([oid]) => oid === entry.baseOid);
      if (inPack) base = inPack[1];
      else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error('ref-delta base missing');
        base = ext;
      }
    }
    const data = applyDelta(base.data, entry.data);
    const oid = sha1(base.type, data);
    objects.set(oid, { type: base.type, data });
  }
  return { objects, deltaCount };
}

// -------------------------------------------------------------------------------------------
// Ref helpers
// -------------------------------------------------------------------------------------------

export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function peelOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') return parseTag(obj.data).object;
  return null;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${DEFAULT_BRANCH}`;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(headTarget(repo));
}

// v0 ref advertisement lines (without the service preamble).
function v0RefLines(repo: Repo, caps: string): Buffer {
  const refs = sortedRefs(repo);
  const items: Array<string | Buffer | 'flush'> = [];
  const capsText = caps;
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${capsText}\n`);
    items.push('flush');
    return pktLines(items);
  }
  const head = headOid(repo) ?? ZERO_OID;
  let first = true;
  const pushLine = (line: string): void => {
    if (first) {
      items.push(`${line}\0${capsText}\n`);
      first = false;
    } else {
      items.push(`${line}\n`);
    }
  };
  pushLine(`${head} HEAD`);
  for (const ref of refs) {
    pushLine(`${ref.oid} ${ref.name}`);
    const peeled = peelOid(repo, ref.oid);
    if (peeled && ref.name.startsWith('refs/tags/')) items.push(`${peeled} ${ref.name}^{}\n`);
  }
  items.push('flush');
  return pktLines(items);
}

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT}`;
const V0_RECEIVE_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

export function infoRefsUpload(repo: Repo, wantV2: boolean): { contentType: string; body: Buffer } {
  if (wantV2) {
    const lines = [
      `# service=git-upload-pack\n`,
      'flush',
      'version 2\n',
      `agent=${AGENT}\n`,
      'object-format=sha1\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done\n',
      'flush',
    ];
    return { contentType: 'application/x-git-upload-pack-advertisement', body: pktLines(lines) };
  }
  const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), pktFlush(), v0RefLines(repo, V0_UPLOAD_CAPS)]);
  return { contentType: 'application/x-git-upload-pack-advertisement', body };
}

export function infoRefsReceive(repo: Repo): { contentType: string; body: Buffer } {
  const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), pktFlush(), v0RefLines(repo, V0_RECEIVE_CAPS)]);
  return { contentType: 'application/x-git-receive-pack-advertisement', body };
}

// -------------------------------------------------------------------------------------------
// upload-pack (v2 ls-refs / fetch, v0 fetch)
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function parseV2Args(lines: string[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const line of lines) {
    if (line === 'delim') {
      seenDelim = true;
      continue;
    }
    if (line === 'flush') break;
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice(8);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Array<string | 'flush'> = [];
  const head = headOid(repo);
  // HEAD is emitted iff it matches a requested prefix (or no prefix was
  // given) — real git returns it for `ref-prefix HEAD` (which `git clone`
  // sends) and omits it for `ref-prefix refs/heads/` alone. An unborn HEAD
  // is spelled `unborn HEAD ...` (never the zero OID) and only when the
  // client asked for `unborn`, exactly as real git and the kit client expect.
  if (keep('HEAD')) {
    const target = headTarget(repo);
    if (head) {
      out.push(`${head} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    } else if (unborn) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const peeled = peel ? peelOid(repo, ref.oid) : null;
    if (peeled) line += ` peeled:${peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return pktLines(out);
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const frame = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(frame));
  }
  return Buffer.concat(parts);
}

/** Compute the fetch object set: depth-limited walk minus what the client holds. */
function fetchObjects(
  repo: Repo,
  args: FetchArgs,
): { packObjects: Array<{ oid: string; type: ObjType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const full = shallowWalk(repo, args.wants, args.depth);
  const haveSet = args.haves.length ? collectHeld(repo, args.haves, args.shallow) : new Set<string>();
  const packObjects: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  for (const oid of full.objects) {
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) packObjects.push({ oid, type: obj.type, data: obj.data });
  }
  // Shallow boundaries are the walk's boundaries, whether or not the client
  // already holds them; a previously shallow boundary now inside the walk is
  // reported unshallow instead.
  const shallow = [...full.boundaries];
  const unshallow = args.shallow.filter((s) => full.objects.has(s) && !full.boundaries.includes(s));
  return { packObjects, shallow, unshallow };
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const { packObjects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(packObjects);
  const parts: Buffer[] = [];
  // Real git's shape (protocol-v2): the acknowledgments section only appears
  // while negotiation is still open (haves sent, no `done`). A fetch that
  // already says `done` goes straight to shallow-info / packfile — sending an
  // acknowledgments section there makes real git fail with
  // "expected 'packfile', received 'acknowledgments'". Sections are separated
  // by delim (0001); only the end of the response is a flush (0000).
  if (args.haves.length > 0 && !args.done) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
  }
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { packObjects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(packObjects);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  const packets = decodePktLines(body);
  if (isV2) {
    const lines: string[] = [];
    for (const p of packets) {
      if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
      else if (p.kind === 'delim') lines.push('delim');
      else if (p.kind === 'flush') lines.push('flush');
    }
    const { command, args } = parseV2Args(lines);
    if (command === 'ls-refs') return lsRefsResponse(repo, args);
    if (command === 'fetch') {
      const fa: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
      for (const a of args) {
        if (a.startsWith('want ')) fa.wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) fa.haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) fa.shallow.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) {
          const n = parseInt(a.slice(7), 10);
          if (Number.isFinite(n)) fa.depth = n;
        } else if (a === 'done') fa.done = true;
      }
      return fetchV2Response(repo, fa);
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  // v0: wants (+deepen) up to the first flush, then haves + done.
  const fa: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) fa.wants.push(text.slice(5).trim().split(' ')[0]!);
    else if (text.startsWith('have ')) fa.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) fa.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7), 10);
      if (Number.isFinite(n)) fa.depth = n;
    } else if (text === 'done') fa.done = true;
  }
  void section;
  return fetchV0Response(repo, fa);
}

// -------------------------------------------------------------------------------------------
// receive-pack (v0)
// -------------------------------------------------------------------------------------------

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  // Find the end of the command pkt-lines: scan raw bytes for the flush packet.
  // The pack that follows is NOT pkt-line framed, so only the command section is decoded.
  let off = 0;
  while (off < body.length) {
    const hex = body.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') {
      off += 4;
      break;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) throw new Error('bad pkt-line in receive-pack');
    off += len;
  }
  packStart = off;
  // Re-decode just the command section.
  const cmdPackets = decodePktLines(body.subarray(0, packStart));
  for (const p of cmdPackets) {
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!m) throw new Error(`bad receive-pack command ${JSON.stringify(text)}`);
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  // The pack follows the command flush (may be empty for delete-only pushes).
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const cmd of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (repo.refs.has(cmd.ref)) {
        repo.refs.delete(cmd.ref);
        ok = true;
      } else {
        ok = true; // deleting a missing ref is a no-op success
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(cmd.ref)) {
        reason = 'already exists';
      } else if (!repo.objects.has(cmd.newOid)) {
        reason = 'object not found';
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        ok = true;
      }
    } else {
      const current = repo.refs.get(cmd.ref);
      if (current === undefined) {
        reason = 'non-fast-forward';
      } else if (current !== cmd.oldOid) {
        reason = 'non-fast-forward';
      } else if (!repo.objects.has(cmd.newOid)) {
        reason = 'object not found';
      } else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        ok = true;
      }
    }
    reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  // report-status inside side-band-64k: the report is itself pkt-line framed in band 1.
  const inner = pktLines([...reportLines, 'flush']);
  const outer = pktLines([Buffer.concat([Buffer.from([1]), inner]), 'flush']);
  return outer;
}
