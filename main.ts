// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves this patch performed, old path -> new path, for `R` lines in the output. */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5) and the file line helpers.       */
/* ------------------------------------------------------------------ */

/** A file's lines, its line break, and whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: Split): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where `o` matches `lines` at `tier`, from `from` on. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where `o` occurs, with its positions. */
function firstTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of N: `ctx` means it is a context line, taken from the file at `oIdx` of O. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * Replace O at `pos` by N. Context lines come from the file's own matched lines; other lines
 * come from the patch, re-indented at tier 2 from O's first line's lead to the file's.
 */
function replaceAt(lines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWS(lines[pos]!);
    p = leadWS(o[0]!);
  }
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      out.push(lines[pos + e.oIdx]!);
    } else {
      let t = e.text;
      if (tier === 2 && o.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
        t = f + t.slice(p.length);
      }
      out.push(t);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

/** Build O and N from hunk/chunk body items, marking which N lines are context lines. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line (no newline after it). */
  noEol?: boolean;
}

function buildON(items: BodyItem[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const oIdx = o.length;
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIdx });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Apply O -> N to a file's text at `pos`, keeping its line break and final break. */
function applyAtText(text: string, pos: number, o: string[], n: NewLine[], tier: number): string {
  const f = splitFile(text);
  const lines = replaceAt(f.lines, pos, o, n, tier);
  return joinFile({ lines, br: f.br, final: f.final });
}

/** The nearest position in `at` to `target`; of two equally near, the earlier. */
function nearest(at: number[], target: number): number {
  let best = at[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of at) {
    const d = Math.abs(p - target);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6).                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function diffPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** Strip a leading `a/` or `b/` from a diff path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Parse the hunks of one unified section, starting at `i`; returns the index after the last hunk. */
function parseHunks(lines: string[], i: number, section: Section): number {
  while (i < lines.length) {
    const line = lines[i]!;
    const m = HUNK_RE.exec(line);
    if (m === null) break;
    const a = Number(m[1]);
    i++;
    const items: BodyItem[] = [];
    let lastNoEol = false;
    // Body lines: ` `, `-`, `+`, `\`, or empty. Ends at any other line, a `diff --git ` line,
    // or a `--- ` line followed by a `+++ ` line. Trailing empty lines are not part of it.
    while (i < lines.length) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
        const kind = b === '' || b.startsWith(' ') ? 'ctx' : b.startsWith('-') ? 'old' : 'new';
        items.push({ kind, text: b === '' ? '' : b.slice(1) });
        i++;
        continue;
      }
      if (b.startsWith('\\')) {
        // A `\` line refers to the body line before it.
        const prev = items[items.length - 1];
        if (prev !== undefined && (prev.kind === 'ctx' || prev.kind === 'new')) {
          // Only the last context/`+` line's flag is read later; mark it if it is the last so far.
          prev.noEol = true;
        }
        i++;
        continue;
      }
      break;
    }
    // Trailing empty context lines are not part of the body.
    while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') {
      items.pop();
    }
    // Whether a `\` follows the hunk's last context or `+` line.
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k]!;
      if (it.kind === 'ctx' || it.kind === 'new') {
        lastNoEol = it.noEol === true;
        break;
      }
    }
    section.hunks.push({ a, items, lastNoEol });
  }
  return i;
}

/** Parse a unified patch into edits, one per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const section: Section = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(section);
      i++;
      i = parseSectionHeader(lines, i, section);
      i = parseHunks(lines, i, section);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const section: Section = {
        oldPath: stripAB(diffPath(line)),
        newPath: stripAB(diffPath(lines[i + 1]!)),
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(section);
      i += 2;
      i = parseSectionHeader(lines, i, section);
      i = parseHunks(lines, i, section);
      continue;
    }
    if (line.startsWith('@@')) {
      // A hunk before any section.
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/**
 * Parse a section's header lines (after `diff --git ` or a `--- `/`+++ ` pair), up to its first
 * hunk or the next section. Returns the index of the first hunk header, or where parsing stops.
 */
function parseSectionHeader(lines: string[], i: number, section: Section): number {
  while (i < lines.length) {
    const line = lines[i]!;
    if (HUNK_RE.test(line)) return i;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      section.oldPath = stripAB(diffPath(line));
      section.newPath = stripAB(diffPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `--- ` line not followed by a `+++ ` line, inside a section's header.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line.startsWith('rename from ')) section.oldPath = line.slice('rename from '.length).trim();
    else if (line.startsWith('rename to ')) section.newPath = line.slice('rename to '.length).trim();
    else if (line.startsWith('new file mode')) section.isCreate = true;
    else if (line.startsWith('deleted file mode')) section.isDelete = true;
    // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and
    // any other line are ignored.
    i++;
  }
  return i;
}

/** One unified section as an edit. */
function unifiedEdit(section: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    const oldIsNull = oldP === null || oldP === '/dev/null';
    const newIsNull = newP === null || newP === '/dev/null';
    const isCreate = section.isCreate || (oldIsNull && !newIsNull);
    const isDelete = section.isDelete || (newIsNull && !oldIsNull);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    const path = isCreate ? newP! : isDelete ? oldP! : isMove ? oldP! : (oldP ?? newP)!;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', path);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let lastNoEol = false;
      for (const h of section.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') out.push(it.text);
        }
        // The last `+` line of the section decides the final break.
        for (let k = h.items.length - 1; k >= 0; k--) {
          if (h.items[k]!.kind === 'new') {
            lastNoEol = h.items[k]!.noEol === true;
            break;
          }
        }
      }
      const text = out.length === 0 ? '' : out.join('\n') + (lastNoEol ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', path);
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      if (oldP === null || newP === null) throw new Fail('unsafe', path);
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applySectionHunks(tree.get(oldP)!, section.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, after);
      tree.moves.set(oldP, newP);
      return;
    }
    // A change of the one path.
    const p = oldP ?? newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applySectionHunks(tree.get(p)!, section.hunks, strict, p));
  };
}

/** Apply a section's hunks in order to a file's text; each hunk sees the result of the last. */
function applySectionHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let cur = text;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = buildON(h.items);
    const f = splitFile(cur);
    if (o.length > 0) {
      const found = firstTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const pos = nearest(found.at, h.a - 1 + d);
      const runsToEnd = pos + o.length === f.lines.length;
      const lines = replaceAt(f.lines, pos, o, n, found.tier);
      const final = runsToEnd ? !h.lastNoEol : f.final;
      cur = joinFile({ lines, br: f.br, final });
    } else {
      const insertAt = Math.min(h.a + d, f.lines.length);
      const atEnd = insertAt === f.lines.length;
      const lines = [...f.lines.slice(0, insertAt), ...n.map((e) => e.text), ...f.lines.slice(insertAt)];
      const final = atEnd ? !h.lastNoEol : f.final;
      cur = joinFile({ lines, br: f.br, final });
    }
    d += n.length - o.length;
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7).                          */
/* ------------------------------------------------------------------ */

/** Parse SEARCH/REPLACE blocks into edits, one per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    // The path: the nearest line before SEARCH, after the previous block's REPLACE (or the
    // start), that is not blank and does not start with three backticks once trimmed.
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    // Find `=======` then `>>>>>>> REPLACE` after SEARCH.
    let eq = -1;
    let rep = -1;
    for (let k = searchAt + 1; k < lines.length; k++) {
      if (eq < 0 && lines[k]!.trimEnd() === '=======') {
        eq = k;
        continue;
      }
      if (eq >= 0 && lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.now.set(path, text);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    tree.now.set(path, applyAtText(cur, found.at[0]!, oldLines, n, found.tier));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8).                                    */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  items: BodyItem[];
  /** Anchored to the end of the file by a `*** End of File` line. */
  atEof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  /** Line number of the `*** Update File: ` line (for the no-chunk parse error). */
  updateLine: number;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DEL) || line.startsWith(V4A_UPD);
}

/** Parse a V4A patch into edits, one per section. */
function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k--) {
      if (!blank(lines[k]!)) return k;
    }
    return -1;
  })();
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith(V4A_ADD)) {
      const path = line.slice(V4A_ADD.length).trim();
      const content: string[] = [];
      i++;
      i = collectV4aLines(lines, i, last, content);
      sections.push({ kind: 'add', path, moveTo: null, lines: content, chunks: [], updateLine: 0 });
      continue;
    }
    if (line.startsWith(V4A_DEL)) {
      const path = line.slice(V4A_DEL.length).trim();
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [], updateLine: 0 });
      i++;
      continue;
    }
    if (line.startsWith(V4A_UPD)) {
      const path = line.slice(V4A_UPD.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith(V4A_MOVE)) {
        moveTo = lines[i]!.slice(V4A_MOVE.length).trim();
        i++;
      }
      const chunks = parseV4aChunks(lines, i, last);
      // Advance i past the chunks: to the next section start or `*** End Patch`.
      i = skipV4aChunks(lines, i, last);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks, updateLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s));
}

/**
 * Collect an Add File section's lines from `i` until a section start or `*** End Patch`.
 * A line is a file line when it starts with `+` or is empty. Blank lines at the end of the
 * section are not part of it. Returns the index after the collected lines.
 */
function collectV4aLines(lines: string[], i: number, last: number, out: string[]): number {
  while (i < last) {
    const line = lines[i]!;
    if (isV4aSectionStart(line) || line.trim() === '*** End Patch') break;
    if (line.startsWith('+')) {
      out.push(line.slice(1));
      i++;
      continue;
    }
    if (line === '') {
      out.push('');
      i++;
      continue;
    }
    if (blank(line)) {
      // A blank line: trailing when only blanks follow up to a section start or End Patch.
      let k = i;
      while (k < last && blank(lines[k]!)) k++;
      if (k >= last || isV4aSectionStart(lines[k]!) || lines[k]!.trim() === '*** End Patch') break;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  // Blank lines at the end of the section are not part of it.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return i;
}

/** Parse the chunks of an Update File section, from `i` to the next section start or End Patch. */
function parseV4aChunks(lines: string[], i: number, last: number): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let firstChunk = true;
  const finish = (): void => {
    if (cur !== null) {
      // Trailing empty context lines are not part of the chunk.
      while (cur.items.length > 0 && cur.items[cur.items.length - 1]!.kind === 'ctx' && cur.items[cur.items.length - 1]!.text === '') {
        cur.items.pop();
      }
      chunks.push(cur);
      cur = null;
    }
  };
  while (i < last) {
    const line = lines[i]!;
    if (isV4aSectionStart(line) || line.trim() === '*** End Patch') break;
    if (line.startsWith('@@')) {
      finish();
      cur = { anchor: line.slice(2).trim(), items: [], atEof: false };
      firstChunk = false;
      i++;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (cur === null) {
        // An `*** End of File` with no open chunk ends an empty chunk only when one began.
        if (!firstChunk) {
          cur = { anchor: null, items: [], atEof: true };
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      cur!.atEof = true;
      finish();
      firstChunk = false;
      i++;
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
        cur = { anchor: null, items: [], atEof: false };
        firstChunk = false;
      }
      const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : 'new';
      cur.items.push({ kind, text: line === '' ? '' : line.slice(1) });
      i++;
      continue;
    }
    if (blank(line)) {
      // A blank line inside a chunk is an empty context line; at the end of the section it is
      // trailing and not part of it. Peek ahead: if only blanks follow to a section start or
      // End Patch, the chunk ends here.
      let k = i;
      while (k < last && blank(lines[k]!)) k++;
      if (k >= last || isV4aSectionStart(lines[k]!) || lines[k]!.trim() === '*** End Patch') break;
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
        cur = { anchor: null, items: [], atEof: false };
        firstChunk = false;
      }
      cur.items.push({ kind: 'ctx', text: '' });
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  finish();
  return chunks;
}

/** The index after an Update File section's chunks: the next section start or End Patch. */
function skipV4aChunks(lines: string[], i: number, last: number): number {
  while (i < last) {
    const line = lines[i]!;
    if (isV4aSectionStart(line) || line.trim() === '*** End Patch') return i;
    i++;
  }
  return i;
}

/** One V4A section as an edit. */
function v4aEdit(section: V4aSection): Edit {
  return (tree) => {
    const p = section.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (section.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const text = section.lines.length === 0 ? '' : section.lines.join('\n') + '\n';
      tree.now.set(p, text);
      return;
    }
    if (section.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // Update File.
    if (tree.get(p) === null) throw new Fail('missing', p);
    const newP = section.moveTo;
    if (newP !== null) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
    }
    const after = applyV4aChunks(tree.get(p)!, section.chunks, p);
    tree.now.set(p, null);
    tree.now.set(newP ?? p, after);
    if (newP !== null) tree.moves.set(p, newP);
  };
}

/** Apply a V4A Update File section's chunks in order, with a cursor that starts at line 0. */
function applyV4aChunks(text: string, chunks: V4aChunk[], path: string): string {
  let f = splitFile(text);
  let cursor = 0;
  for (const chunk of chunks) {
    const { o, n } = buildON(chunk.items);
    if (chunk.anchor !== null && chunk.anchor !== '') {
      // Find the first line at or after the cursor equal to the anchor, at the first tier.
      const anchorLines = [chunk.anchor];
      let anchorAt: number | null = null;
      for (const tier of [0, 1, 2]) {
        const at = occurrences(f.lines, anchorLines, tier, cursor);
        if (at.length > 0) {
          anchorAt = at[0]!;
          break;
        }
      }
      if (anchorAt === null) throw new Fail('no-match', path);
      cursor = anchorAt + 1;
    }
    if (o.length === 0) {
      const insertAt = chunk.atEof ? f.lines.length : cursor;
      const lines = [...f.lines.slice(0, insertAt), ...n.map((e) => e.text), ...f.lines.slice(insertAt)];
      cursor = insertAt + n.length;
      f = { ...f, lines };
      continue;
    }
    const found = firstTier(f.lines, o, false, cursor);
    if (found === null) throw new Fail('no-match', path);
    let pos: number;
    if (chunk.atEof) {
      const ends = found.at.filter((at) => at + o.length === f.lines.length);
      if (ends.length === 0) throw new Fail('no-match', path);
      pos = ends[0]!;
    } else {
      pos = found.at[0]!;
    }
    const lines = replaceAt(f.lines, pos, o, n, found.tier);
    cursor = pos + n.length;
    f = { ...f, lines };
  }
  return joinFile(f);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths. A move whose old path existed before and does
  // not after, and whose new path did not exist before and does after, is one `R` line that
  // replaces that pair's `D` and `A` lines and sorts by the new path.
  const rowByKey = new Map<string, string>();
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.now.get(oldP) === null && tree.now.get(newP) !== null) {
      rowByKey.set(newP, `R ${oldP} -> ${newP}`);
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowByKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows = [...rowByKey.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([, line]) => line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
