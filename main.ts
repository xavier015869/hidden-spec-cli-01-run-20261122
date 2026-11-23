// mend: one command-line tool that applies the edits AI models write to a
// tree of text files. It reads four formats -- unified diffs (whose line
// numbers are often wrong), SEARCH/REPLACE blocks, V4A patches and JSON tool
// calls -- and changes every file or none, exactly as SPEC.md says.
//
// Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` in
// the root of the tree. Node 22 and its standard library alone; no installs.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse failure: the CLI answers `error: parse <N>` and exits 2. */
class ParseFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that could not be applied: reported, and the patch still runs on. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** The patch's lines: split at `\n`, one trailing `\r` off each, and no empty
 * piece after a final `\n`. Line numbers count these from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of UTF-8, for sorting output rows. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines: its line break, its lines, and whether it ends with one.
 * An empty file has no lines and does not end with a line break. */
interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** The leading spaces and tabs of a line. */
function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** How a line compares at a tier: tier 0 exact, tier 1 trailing spaces and
 * tabs off both sides, tier 2 leading and trailing spaces and tabs off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const noTrail = line.replace(/[ \t]+$/, '');
  if (tier === 1) return noTrail;
  return noTrail.replace(/^[ \t]+/, '');
}

/** Every 0-based position where `oldLines` occurs in `lines` at `tier`. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const keys = oldLines.map((l) => tierKey(l, tier));
  const found: number[] = [];
  for (let i = 0; i + keys.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < keys.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which `oldLines` occurs at least once (tier 0 only
 * under --strict), with every occurrence at that tier; null when it occurs
 * at no tier. */
function findOccurrences(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from = 0,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, oldLines, tier).filter((i) => i >= from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. `kind` is the marker that
 * introduced it: `' '` context, `'-'` old, `'+'` new, `'\\'` a backslash line
 * (`\ No newline at end of file` and the like). `raw` is the patch line as
 * written, kept so trailing truly-empty lines can be told from context lines
 * that only look empty. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

/** Split a hunk or chunk body into the old lines O and the new lines N, and
 * for each line of N the index of the old line it is the context of (-1 when
 * it is a `+` line). Context lines are the ones in both. */
function splitBody(body: BodyLine[]): { oldLines: string[]; newLines: string[]; ctxOf: number[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctxOf: number[] = [];
  for (const item of body) {
    if (item.kind === ' ') {
      ctxOf.push(oldLines.length);
      oldLines.push(item.text);
      newLines.push(item.text);
    } else if (item.kind === '-') {
      oldLines.push(item.text);
    } else if (item.kind === '+') {
      ctxOf.push(-1);
      newLines.push(item.text);
    }
  }
  return { oldLines, newLines, ctxOf };
}

/** The lines N writes when it replaces O at `pos` in `fileLines`. A context
 * line is written as the file's own matched line, never the patch's. At tier
 * 2 every other line is re-indented: with F the leading whitespace of the
 * file's first matched line and P that of O's first line, a non-blank line
 * starting with P has that P replaced by F. At tiers 0 and 1 the lines of N
 * are written as they are. */
function writeNew(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newLines: string[],
  ctxOf: number[],
  tier: number,
): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const f = leadOf(fileLines[pos] ?? '');
    const p = leadOf(oldLines[0] ?? '');
    for (let j = 0; j < newLines.length; j += 1) {
      const line = newLines[j]!;
      const ctx = ctxOf[j]!;
      if (ctx >= 0) {
        out.push(fileLines[pos + ctx]!);
      } else if (line !== '' && line.trim() !== '' && line.startsWith(p)) {
        out.push(f + line.slice(p.length));
      } else {
        out.push(line);
      }
    }
    return out;
  }
  for (let j = 0; j < newLines.length; j += 1) {
    const ctx = ctxOf[j]!;
    out.push(ctx >= 0 ? fileLines[pos + ctx]! : newLines[j]!);
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLastKept(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** The tree as the edits leave it. `now` holds every path an edit touched
 * (null: deleted); anything else is read from disk, once, and remembered. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One parsed edit. It throws EditFault when it cannot apply; a failed edit
 * changes nothing. `moves` collects every move that succeeded, so the
 * report can print `R old -> new` for it. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

/** The options every edit closes over. */
interface EditOpts {
  strict: boolean;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      // In a CRLF file the file's text and both strings are read with every
      // `\r\n` as `\n`, and the result is written back with `\r\n`.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const plain = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = plain(before);
      const old = plain(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + plain(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const model = splitFile(before);
      if (lineNo < 0 || lineNo > model.lines.length) throw new EditFault('no-match', p);
      const lines = [...model.lines];
      lines.splice(lineNo, 0, ...added);
      tree.now.set(p, joinFile({ ...model, lines }));
    };
  }

  return null;
}

/** The JSON edits of a patch: one JSON array of edit objects, or JSON
 * Lines with one edit object a line and blank lines ignored. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: its old start A (B and D are not used) and its body. */
interface Hunk {
  oldStart: number;
  body: BodyLine[];
  lineNo: number;
}

/** One unified section: the paths its header names, from each source, and
 * its hunks. A section is one edit. */
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
}

const blankSection = (): Section => ({
  diffOld: null,
  diffNew: null,
  pairOld: null,
  pairNew: null,
  renameOld: null,
  renameNew: null,
  createMode: false,
  deleteMode: false,
  hunks: [],
});

/** The path a `--- ` or `+++ ` line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from a `---` or `+++` path. */
function unprefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a source names: the `---`/`+++` pair first, then `rename
 * from`/`rename to`, then the `diff --git` paths. */
function resolvePath(pair: string | null, rename: string | null, diff: string | null): string | null {
  if (pair !== null) return unprefix(pair);
  if (rename !== null) return rename;
  return diff;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

/** Apply a section's hunks in order to a file's lines. `d` is the sum over
 * the hunks applied so far of (N's length minus O's length). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): FileModel {
  let lines = [...model.lines];
  let finalBreak = model.finalBreak;
  let d = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines, ctxOf } = splitBody(hunk.body);
    if (oldLines.length === 0) {
      const insertAt = hunk.oldStart + d;
      const atEnd = insertAt >= lines.length;
      const at = Math.max(0, Math.min(insertAt, lines.length));
      lines.splice(at, 0, ...newLines);
      if (atEnd) finalBreak = !backslashAfterLastKept(hunk.body);
      d += newLines.length;
      continue;
    }
    const found = findOccurrences(lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', failPath);
    const target = hunk.oldStart - 1 + d;
    let best = found.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.at) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const runsToEnd = best + oldLines.length === lines.length;
    const written = writeNew(lines, best, oldLines, newLines, ctxOf, found.tier);
    lines.splice(best, oldLines.length, ...written);
    if (runsToEnd) finalBreak = !backslashAfterLastKept(hunk.body);
    d += newLines.length - oldLines.length;
  }
  return { br: model.br, lines, finalBreak };
}

/** One unified section as one edit. */
function unifiedEdit(sec: Section, opts: EditOpts): Edit {
  const oldP = resolvePath(sec.pairOld, sec.renameOld, sec.diffOld);
  const newP = resolvePath(sec.pairNew, sec.renameNew, sec.diffNew);
  const oldPath = oldP ?? newP ?? '';
  const newPath = newP ?? oldP ?? '';
  const isCreate = sec.createMode || oldP === '/dev/null';
  const isDelete = !isCreate && (sec.deleteMode || newP === '/dev/null');
  const isMove = !isCreate && !isDelete && oldP !== newP;

  /** Every path the section names is checked for safety before anything
   * else about it; `/dev/null` means no file and is not a path. */
  const checkSafe = (p: string): void => {
    if (p !== '/dev/null' && !safePath(p)) throw new EditFault('unsafe', p);
  };

  return (tree, moves) => {
    checkSafe(oldPath);
    checkSafe(newPath);
    if (isCreate) {
      if (newPath === '/dev/null') throw new EditFault('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const hunk of sec.hunks) {
        for (let k = 0; k < hunk.body.length; k += 1) {
          if (hunk.body[k]!.kind === '+') {
            plus.push(hunk.body[k]!.text);
            lastPlus = { hunk, idx: k };
          }
        }
      }
      let noFinal = false;
      if (lastPlus !== null) {
        const next = lastPlus.hunk.body[lastPlus.idx + 1];
        noFinal = next !== undefined && next.kind === '\\';
      }
      tree.now.set(newPath, joinFile({ br: '\n', lines: plus, finalBreak: !noFinal }));
      return;
    }
    if (isDelete) {
      if (oldPath === '/dev/null') throw new EditFault('missing', oldPath);
      if (tree.get(oldPath) === null) throw new EditFault('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (isMove) {
      const cur = tree.get(oldPath);
      if (cur === null) throw new EditFault('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const out = applyHunks(splitFile(cur), sec.hunks, opts.strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(out));
      moves.push([oldPath, newPath]);
      return;
    }
    const cur = tree.get(oldPath);
    if (cur === null) throw new EditFault('missing', oldPath);
    const out = applyHunks(splitFile(cur), sec.hunks, opts.strict, oldPath);
    tree.now.set(oldPath, joinFile(out));
  };
}

/** Read a unified diff into edits. Outside bodies, lines that are not part
 * of a section header are ignored (prose, code fences). */
function parseUnified(lines: string[], opts: EditOpts): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let phase: 'header' | 'body' | 'between' = 'header';
  let body: BodyLine[] = [];
  let bodyHunk: Hunk | null = null;

  const closeBody = (): void => {
    if (bodyHunk !== null && sec !== null) {
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      bodyHunk.body = body;
      sec.hunks.push(bodyHunk);
      bodyHunk = null;
      body = [];
    }
    phase = 'between';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (phase === 'body') {
      if (line.startsWith('diff --git ')) {
        closeBody();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        body.push({ kind: line === '' ? ' ' : (line[0] as BodyLine['kind']), text: line === '' ? '' : line.slice(1), raw: line });
        i += 1;
        continue;
      }
      closeBody();
      continue;
    }
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT.exec(line.trimEnd());
      if (m === null) throw new ParseFault(`error: parse ${no}`);
      sec = blankSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      phase = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair starts a new section unless it is the pair of the section
      // whose header is open: a section that already has its pair is not
      // still collecting one, so a further pair is not part of its header.
      if (sec === null || phase === 'between' || sec.pairOld !== null) {
        sec = blankSection();
        sections.push(sec);
      }
      sec.pairOld = headerPath(line);
      sec.pairNew = headerPath(lines[i + 1]!);
      phase = 'header';
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (sec !== null && phase === 'header') throw new ParseFault(`error: parse ${no + 1}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(`error: parse ${no}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${no}`);
      bodyHunk = { oldStart: Number(m[1]), body: [], lineNo: no };
      body = [];
      phase = 'body';
      i += 1;
      continue;
    }
    if (sec !== null && phase === 'header') {
      if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.createMode = true;
      else if (line.startsWith('deleted file mode')) sec.deleteMode = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  closeBody();
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((s) => unifiedEdit(s, opts));
}

/** One SEARCH/REPLACE block as one edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], opts: EditOpts): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, joinFile({ br: '\n', lines: newLines, finalBreak: true }));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const model = splitFile(cur);
    const found = findOccurrences(model.lines, oldLines, opts.strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.at.length > 1) throw new EditFault('ambiguous', path);
    const pos = found.at[0]!;
    const noneCtx = newLines.map(() => -1);
    const lines = [...model.lines];
    lines.splice(pos, oldLines.length, ...writeNew(model.lines, pos, oldLines, newLines, noneCtx, found.tier));
    tree.now.set(path, joinFile({ ...model, lines }));
  };
}

/** Read SEARCH/REPLACE blocks into edits. Lines outside blocks are ignored. */
function parseSearchReplace(lines: string[], opts: EditOpts): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(`error: parse ${searchNo}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new ParseFault(`error: parse ${searchNo}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFault(`error: parse ${searchNo}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), opts));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** One V4A chunk: its anchor (null: none), its body, and whether a
 * `*** End of File` line anchors it to the end of the file. */
interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

/** The first line at or after `from` equal to the anchor at the first tier
 * where one is (both sides a single line). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, tier) === tierKey(anchor, tier)) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one;
 * an end-of-file chunk takes only an occurrence that ends at the file's
 * last line. */
function findChunkOccurrence(
  lines: string[],
  oldLines: string[],
  from: number,
  eof: boolean,
  strict: boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, oldLines, tier).filter(
      (i) => i >= from && (!eof || i + oldLines.length === lines.length),
    );
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One V4A Add File section as one edit. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, joinFile({ br: '\n', lines: fileLines, finalBreak: true }));
  };
}

/** One V4A Delete File section as one edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as one edit. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], opts: EditOpts): Edit {
  return (tree, moves) => {
    if (!safePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const model = splitFile(cur);
    let lines = [...model.lines];
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(lines, chunk.anchor, cursor, opts.strict);
        if (at === null) throw new EditFault('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newLines, ctxOf } = splitBody(chunk.body);
      if (oldLines.length === 0) {
        const at = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...newLines);
        cursor = at + newLines.length;
        continue;
      }
      const found = findChunkOccurrence(lines, oldLines, cursor, chunk.eof, opts.strict);
      if (found === null) throw new EditFault('no-match', path);
      const pos = found.at[0]!;
      const written = writeNew(lines, pos, oldLines, newLines, ctxOf, found.tier);
      lines.splice(pos, oldLines.length, ...written);
      cursor = pos + newLines.length;
    }
    const out = joinFile({ ...model, lines });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a V4A patch into edits. */
function parseV4a(lines: string[], opts: EditOpts): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  const edits: Edit[] = [];
  let i = first + 1;
  for (;;) {
    while (i <= last && isBlank(lines[i]!)) i += 1;
    if (i > last) throw new ParseFault(`error: parse ${lines.length + 1}`);
    const line = lines[i]!;
    if (line.trim() === '*** End Patch') {
      if (i !== last) throw new ParseFault(`error: parse ${lines.length + 1}`);
      break;
    }
    const head = V4A_SECTION.exec(line);
    if (head === null) throw new ParseFault(`error: parse ${i + 1}`);
    const kind = head[1]!;
    const path = head[2]!.trim();
    const sectionNo = i + 1;
    i += 1;
    const raw: { line: string; no: number }[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      // A line starting with a space is a body line of the section (its
      // text may read as a marker); it never ends the section.
      if (V4A_SECTION.test(l) || (l.trim() === '*** End Patch' && !l.startsWith(' '))) break;
      raw.push({ line: l, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.line)) raw.pop();
    if (kind === 'Add File') {
      const fileLines: string[] = [];
      for (const { line: l, no } of raw) {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseFault(`error: parse ${no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'Delete File') {
      if (raw.length > 0) throw new ParseFault(`error: parse ${raw[0]!.no}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (k < raw.length && raw[k]!.line.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.line.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (k < raw.length) {
        const { line: l, no } = raw[k]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          firstChunk = false;
          k += 1;
        } else if (l.trim() === '*** End of File' && !l.startsWith(' ')) {
          if (cur === null) throw new ParseFault(`error: parse ${no}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          k += 1;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) throw new ParseFault(`error: parse ${no}`);
            cur = { anchor: null, body: [], eof: false };
            firstChunk = false;
          }
          cur.body.push({ kind: l === '' ? ' ' : (l[0] as BodyLine['kind']), text: l === '' ? '' : l.slice(1), raw: l });
          k += 1;
        } else {
          throw new ParseFault(`error: parse ${no}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${sectionNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, opts));
    }
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

/** With `--format=auto` the format is the first of these that holds, where a
 * blank line is one that is empty or only whitespace. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** The exit-0 report rows for a tree the edits left behind: one line for
 * each path whose state changed, in byte order of the paths (UTF-8). A move
 * prints `R <old> -> <new>` and sorts by `<new>`; it replaces that pair's
 * `D` and `A` lines, but only when the move itself is what left the old
 * path gone and the new path there -- a file moved twice, or moved and then
 * made again, is reported as the delete and the create it nets to. */
function reportRows(tree: Tree, moves: Array<[string, string]>): { key: string; line: string }[] {
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return rows;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const opts: EditOpts = { strict };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'unified'
        ? parseUnified(lines, opts)
        : kind === 'search-replace'
          ? parseSearchReplace(lines, opts)
          : kind === 'v4a'
            ? parseV4a(lines, opts)
            : jsonEdits(text, lines);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = reportRows(tree, moves);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
