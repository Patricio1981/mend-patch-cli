// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only; run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: '\r\n' | '\n', final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Provenance for move edits: maps a live path to the original path it was moved from (null if newly created/deleted). */
  readonly origin = new Map<string, string | null>();

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

  private originOf(p: string): string | null {
    if (this.origin.has(p)) return this.origin.get(p)!;
    return this.original(p) !== null ? p : null;
  }

  create(p: string, text: string): void {
    this.now.set(p, text);
    this.origin.set(p, null);
  }

  write(p: string, text: string): void {
    this.now.set(p, text);
  }

  remove(p: string): void {
    this.now.set(p, null);
    this.origin.set(p, null);
  }

  move(oldPath: string, newPath: string, text: string): void {
    const src = this.originOf(oldPath);
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.origin.set(oldPath, null);
    this.origin.set(newPath, src);
  }
}

type Edit = (tree: Tree) => void;

// --- Section 4: Format detection ---

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

// --- Section 5: Matching lines ---

function normTier(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function leadingSpacesTabs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function matchesAt(fileLines: string[], pos: number, oldLines: string[], tier: number): boolean {
  for (let j = 0; j < oldLines.length; j += 1) {
    if (normTier(fileLines[pos + j]!, tier) !== normTier(oldLines[j]!, tier)) return false;
  }
  return true;
}

/** Find all occurrences of `oldLines` in `fileLines` at the first tier (0..maxTier) with at least one occurrence. */
function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startPos = 0,
  onlyPos: number | null = null,
): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  const maxStart = fileLines.length - oldLines.length;
  if (onlyPos !== null) {
    if (onlyPos < startPos || onlyPos > maxStart) return null;
    for (let tier = 0; tier <= maxTier; tier += 1) {
      if (matchesAt(fileLines, onlyPos, oldLines, tier)) return { tier, positions: [onlyPos] };
    }
    return null;
  }
  if (startPos > maxStart) return null;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const positions: number[] = [];
    for (let i = startPos; i <= maxStart; i += 1) {
      if (matchesAt(fileLines, i, oldLines, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type NewItem = { kind: 'ctx'; oIdx: number } | { kind: 'add'; text: string };

function buildReplacement(fileLines: string[], matchPos: number, firstOld: string, newItems: NewItem[], tier: number): string[] {
  const fIndent = leadingSpacesTabs(fileLines[matchPos]!);
  const pIndent = leadingSpacesTabs(firstOld);
  return newItems.map((item) => {
    if (item.kind === 'ctx') return fileLines[matchPos + item.oIdx]!;
    if (tier === 2 && !blank(item.text) && item.text.startsWith(pIndent)) {
      return fIndent + item.text.slice(pIndent.length);
    }
    return item.text;
  });
}

// --- Section 6: Unified diffs ---

interface UnifiedHunk {
  oldStart: number;
  oldLines: string[];
  newItems: NewItem[];
  plusLines: string[];
  lastNewNoEol: boolean;
  lastPlusNoEol: boolean;
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  hasMinusPlus: boolean;
  minusPath: string | null; // null when /dev/null
  plusPath: string | null; // null when /dev/null
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
}

function parseDiffGitLine(line: string, lineNo: number): [string, string] {
  if (!line.startsWith('diff --git a/')) throw new Exit2(`error: parse ${lineNo}`);
  const rest = line.slice('diff --git a/'.length);
  // Prefer a split where X === Y (handles paths containing " b/"), otherwise first " b/".
  let splitIdx = -1;
  for (let idx = rest.indexOf(' b/'); idx >= 0; idx = rest.indexOf(' b/', idx + 1)) {
    const x = rest.slice(0, idx);
    const y = rest.slice(idx + 3);
    if (x !== '' && y !== '' && x === y) {
      splitIdx = idx;
      break;
    }
    if (splitIdx < 0 && x !== '' && y !== '') splitIdx = idx;
  }
  if (splitIdx < 0) throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(0, splitIdx), rest.slice(splitIdx + 3)];
}

function parseUnifiedHeaderPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  let p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const UNIFIED_HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function makeUnifiedSection(): UnifiedSection {
  return {
    gitOld: null,
    gitNew: null,
    hasMinusPlus: false,
    minusPath: null,
    plusPath: null,
    renameFrom: null,
    renameTo: null,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : null;

    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const [gx, gy] = parseDiffGitLine(l, i + 1);
      cur = makeUnifiedSection();
      cur.gitOld = gx;
      cur.gitNew = gy;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }

    if (l.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
      if (cur === null || !inHeader || cur.hasMinusPlus) {
        cur = makeUnifiedSection();
        sections.push(cur);
        inHeader = true;
      }
      cur.hasMinusPlus = true;
      cur.minusPath = parseUnifiedHeaderPath(l);
      cur.plusPath = parseUnifiedHeaderPath(next);
      i += 2;
      continue;
    }

    if (inHeader && cur !== null && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }

    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = UNIFIED_HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]!);
      i += 1;

      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        const bNext = i + 1 < lines.length ? lines[i + 1]! : null;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && bNext !== null && bNext.startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          rawBody.push(bl);
          i += 1;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();

      const oldLines: string[] = [];
      const newItems: NewItem[] = [];
      const plusLines: string[] = [];
      let lastKind: 'ctx' | 'del' | 'add' | null = null;
      let lastNewNoEol = false;
      let lastPlusNoEol = false;

      for (const bl of rawBody) {
        if (bl === '') {
          const oIdx = oldLines.length;
          oldLines.push('');
          newItems.push({ kind: 'ctx', oIdx });
          lastKind = 'ctx';
          lastNewNoEol = false;
        } else if (bl.startsWith(' ')) {
          const oIdx = oldLines.length;
          oldLines.push(bl.slice(1));
          newItems.push({ kind: 'ctx', oIdx });
          lastKind = 'ctx';
          lastNewNoEol = false;
        } else if (bl.startsWith('-')) {
          oldLines.push(bl.slice(1));
          lastKind = 'del';
        } else if (bl.startsWith('+')) {
          const text = bl.slice(1);
          newItems.push({ kind: 'add', text });
          plusLines.push(text);
          lastKind = 'add';
          lastNewNoEol = false;
          lastPlusNoEol = false;
        } else if (bl.startsWith('\\')) {
          if (lastKind === 'ctx' || lastKind === 'add') lastNewNoEol = true;
          if (lastKind === 'add') lastPlusNoEol = true;
          lastKind = null;
        }
      }

      cur.hunks.push({ oldStart, oldLines, newItems, plusLines, lastNewNoEol, lastPlusNoEol });
      continue;
    }

    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.newFileMode = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.deletedFileMode = true;
    }

    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldIsNull = sec.hasMinusPlus && sec.minusPath === null;
    const newIsNull = sec.hasMinusPlus && sec.plusPath === null;
    const oldPath = sec.hasMinusPlus ? sec.minusPath : (sec.renameFrom ?? sec.gitOld);
    const newPath = sec.hasMinusPlus ? sec.plusPath : (sec.renameTo ?? sec.gitNew);

    const isCreation = oldIsNull || sec.newFileMode;
    const isDeletion = !isCreation && (newIsNull || sec.deletedFileMode);

    return (tree: Tree) => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);

      if (isCreation) {
        if (newPath === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const createdLines: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          if (h.plusLines.length > 0) {
            createdLines.push(...h.plusLines);
            noEol = h.lastPlusNoEol;
          }
        }
        tree.create(newPath, joinFile(createdLines, '\n', !noEol));
        return;
      }

      if (isDeletion) {
        if (oldPath === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.remove(oldPath);
        return;
      }

      const src = oldPath!;
      const dst = newPath!;
      const isMove = src !== dst;

      const before = tree.get(src);
      if (before === null) throw new Fail('missing', src);
      if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);

      const file = splitFile(before);
      const curLines = file.lines;
      let final = file.final;
      let d = 0;

      for (const h of sec.hunks) {
        if (h.oldLines.length > 0) {
          const found = findOccurrences(curLines, h.oldLines, strict);
          if (found === null) throw new Fail('no-match', src);
          const targetPos = h.oldStart - 1 + d;
          let bestPos = found.positions[0]!;
          let bestDist = Math.abs(bestPos - targetPos);
          for (let k = 1; k < found.positions.length; k += 1) {
            const p = found.positions[k]!;
            const dist = Math.abs(p - targetPos);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = p;
            }
          }
          const atEnd = bestPos + h.oldLines.length === curLines.length;
          const repl = buildReplacement(curLines, bestPos, h.oldLines[0]!, h.newItems, found.tier);
          curLines.splice(bestPos, h.oldLines.length, ...repl);
          if (atEnd) final = !h.lastNewNoEol;
          d += repl.length - h.oldLines.length;
        } else {
          const insertPos = Math.max(0, Math.min(h.oldStart + d, curLines.length));
          const atEnd = insertPos === curLines.length;
          const repl = h.newItems.map((it) => (it.kind === 'add' ? it.text : ''));
          curLines.splice(insertPos, 0, ...repl);
          if (atEnd) final = !h.lastNewNoEol;
          d += repl.length;
        }
      }

      const result = joinFile(curLines, file.br, final);
      if (isMove) tree.move(src, dst, result);
      else tree.write(src, result);
    };
  });
}

// --- Section 7: SEARCH/REPLACE blocks ---

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevBlockEnd = -1;
  let prevPath: string | null = null;

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;

    let path: string | null = null;
    for (let j = i - 1; j > prevBlockEnd; j -= 1) {
      const cand = lines[j]!;
      if (!blank(cand) && !cand.trim().startsWith('```')) {
        path = cand.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }

    let sepIdx = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sepIdx = k;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchLine}`);

    let endIdx = -1;
    for (let k = sepIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = k;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchLine}`);

    const oldLines = lines.slice(i + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    const editPath = path;

    prevPath = editPath;
    prevBlockEnd = endIdx;
    i = endIdx + 1;

    edits.push((tree: Tree) => {
      if (!safe(editPath)) throw new Fail('unsafe', editPath);
      if (oldLines.length === 0) {
        if (tree.get(editPath) !== null) throw new Fail('exists', editPath);
        tree.create(editPath, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(editPath);
      if (before === null) throw new Fail('missing', editPath);
      const file = splitFile(before);
      const found = findOccurrences(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', editPath);
      if (found.positions.length > 1) throw new Fail('ambiguous', editPath);
      const pos = found.positions[0]!;
      const newItems: NewItem[] = newLines.map((text) => ({ kind: 'add', text }));
      const repl = buildReplacement(file.lines, pos, oldLines[0]!, newItems, found.tier);
      file.lines.splice(pos, oldLines.length, ...repl);
      tree.write(editPath, joinFile(file.lines, file.br, file.final));
    });
  }

  return edits;
}

// --- Section 8: V4A patches ---

interface V4aChunk {
  anchor: string;
  oldLines: string[];
  newItems: NewItem[];
  eof: boolean;
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;

    const header = lines[i]!;
    const headerLineNo = i + 1;

    if (!isV4aSectionStart(header)) throw new Exit2(`error: parse ${headerLineNo}`);

    if (header.startsWith('*** Delete File: ')) {
      const path = header.slice('*** Delete File: '.length).trim();
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.remove(path);
      });
      i += 1;
      continue;
    }

    let secEnd = i + 1;
    while (secEnd < last && !isV4aSectionStart(lines[secEnd]!)) secEnd += 1;
    let bodyEnd = secEnd;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;

    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let k = i + 1; k < bodyEnd; k += 1) {
        const bl = lines[k]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.create(path, joinFile(fileLines, '\n', true));
      });
    } else {
      const path = header.slice('*** Update File: '.length).trim();
      let k = i + 1;
      let moveTo: string | null = null;
      if (k < bodyEnd && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k += 1;
      }

      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;

      while (k < bodyEnd) {
        const bl = lines[k]!;
        if (bl.startsWith('@@')) {
          curChunk = { anchor: bl.slice(2).trim(), oldLines: [], newItems: [], eof: false };
          chunks.push(curChunk);
          k += 1;
        } else if (bl === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${k + 1}`);
          curChunk.eof = true;
          curChunk = null;
          k += 1;
        } else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            curChunk = { anchor: '', oldLines: [], newItems: [], eof: false };
            chunks.push(curChunk);
          }
          if (bl === '') {
            const oIdx = curChunk.oldLines.length;
            curChunk.oldLines.push('');
            curChunk.newItems.push({ kind: 'ctx', oIdx });
          } else if (bl.startsWith(' ')) {
            const oIdx = curChunk.oldLines.length;
            curChunk.oldLines.push(bl.slice(1));
            curChunk.newItems.push({ kind: 'ctx', oIdx });
          } else if (bl.startsWith('-')) {
            curChunk.oldLines.push(bl.slice(1));
          } else {
            curChunk.newItems.push({ kind: 'add', text: bl.slice(1) });
          }
          k += 1;
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }

      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNo}`);

      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const file = splitFile(before);
        const curLines = file.lines;
        let cursor = 0;

        for (const ch of chunks) {
          if (ch.anchor !== '') {
            const anchorFound = findOccurrences(curLines, [ch.anchor], strict, cursor);
            if (anchorFound === null) throw new Fail('no-match', path);
            cursor = anchorFound.positions[0]! + 1;
          }

          if (ch.oldLines.length === 0) {
            const insertPos = ch.eof ? curLines.length : cursor;
            const repl = ch.newItems.map((it) => (it.kind === 'add' ? it.text : ''));
            curLines.splice(insertPos, 0, ...repl);
            cursor = insertPos + repl.length;
          } else {
            const onlyPos = ch.eof ? curLines.length - ch.oldLines.length : null;
            const found = findOccurrences(curLines, ch.oldLines, strict, cursor, onlyPos);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const repl = buildReplacement(curLines, pos, ch.oldLines[0]!, ch.newItems, found.tier);
            curLines.splice(pos, ch.oldLines.length, ...repl);
            cursor = pos + repl.length;
          }
        }

        const result = joinFile(curLines, file.br, file.final);
        if (moveTo !== null) tree.move(path, moveTo, result);
        else tree.write(path, result);
      });
    }

    i = secEnd;
  }

  return edits;
}

// --- Section 9: JSON edits ---

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
      tree.create(p, text);
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
      tree.write(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.write(p, joinFile(file.lines, file.br, file.final));
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
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Sections 1, 2, 10: CLI entry, atomicity, output ---

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeOrigin = new Map(tree.origin);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of beforeOrigin) tree.origin.set(k, v);
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const added: string[] = [];
  const deleted = new Set<string>();
  const modified: string[] = [];
  const toDelete: string[] = [];
  const toWrite: Array<[string, string]> = [];

  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    if (was === null && now !== null) {
      added.push(p);
      toWrite.push([p, now]);
    } else if (was !== null && now === null) {
      deleted.add(p);
      toDelete.push(p);
    } else if (was !== null && now !== null) {
      modified.push(p);
      toWrite.push([p, now]);
    }
  }

  const rows: Array<{ sortKey: string; line: string }> = [];
  const consumedDeleted = new Set<string>();

  for (const newP of added) {
    const src = tree.origin.get(newP) ?? null;
    if (src !== null && deleted.has(src) && !consumedDeleted.has(src)) {
      consumedDeleted.add(src);
      rows.push({ sortKey: newP, line: `R ${src} -> ${newP}` });
    } else {
      rows.push({ sortKey: newP, line: `A ${newP}` });
    }
  }
  for (const p of deleted) {
    if (!consumedDeleted.has(p)) rows.push({ sortKey: p, line: `D ${p}` });
  }
  for (const p of modified) {
    rows.push({ sortKey: p, line: `M ${p}` });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));

  if (!check) {
    for (const p of toDelete) {
      rmSync(p, { force: true });
      let d = dirname(p);
      while (d !== '.' && d !== '' && d !== '/') {
        try {
          rmdirSync(d);
        } catch {
          break;
        }
        d = dirname(d);
      }
    }
    for (const [p, content] of toWrite) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }

  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
