/**
 * Local edits to "Things you said": hidden ranges and removed quotes.
 *
 * Originals stay in the machine snapshots; edits live beside them in
 * localStorage and are applied at render time. The share link is built from
 * the edited list, so a hidden run travels as a spoiler and a removed quote
 * does not travel at all — while undo keeps working here, where the originals
 * still are.
 */

import type { Quote } from "./types.js";

const KEY = "promptstreak:quotes";
export const BLOCK = "█";
const RUN_MIN = 3;
const RUN_MAX = 12;

interface Edit {
  /** Text after hiding; absent when only removed. */
  t?: string;
  del?: true;
}
type Edits = Record<string, Edit>;

/** Identity of a quote as the CLI produced it — the same on every machine that holds it. */
export const qkey = (q: Quote): string => `${q.d}|${q.t}`;

function load(): Edits {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Edits;
  } catch {
    return {};
  }
}

let edits: Edits = load();
const undoStack: Edits[] = [];

function commit(next: Edits): void {
  undoStack.push(edits);
  if (undoStack.length > 50) undoStack.shift();
  edits = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(edits));
  } catch {
    // Private mode or a full quota: the edit still holds for this visit.
  }
}

export interface Shown {
  q: Quote;
  key: string;
}

/** The quotes as they should appear and ship: removed ones dropped, hidden runs blocked out. */
export function applyEdits(qs: Quote[]): Shown[] {
  return qs.flatMap((q) => {
    const key = qkey(q);
    const e = edits[key];
    if (e?.del) return [];
    return [{ q: e?.t !== undefined ? { ...q, t: e.t } : q, key }];
  });
}

export const hasEdits = (): boolean => Object.keys(edits).length > 0;

/**
 * Blank out [start, end) with a spoiler run. A block glyph is roughly three
 * letters wide, so the run is a third of the hidden length — the blank sits in
 * the sentence about the way the words did, without spelling out their length.
 */
export function spoil(shown: string, start: number, end: number): string {
  if (end <= start) return shown;
  const run = BLOCK.repeat(Math.min(RUN_MAX, Math.max(RUN_MIN, Math.round((end - start) / 3))));
  return (shown.slice(0, start) + run + shown.slice(end))
    // Adjacent runs merge; keep the merged run within bounds.
    .replace(/█+/g, (r) => (r.length > RUN_MAX ? BLOCK.repeat(RUN_MAX) : r))
    .replace(/\s+/g, " ")
    .trim();
}

export function hideRange(key: string, shown: string, start: number, end: number): void {
  if (end <= start) return;
  commit({ ...edits, [key]: { ...edits[key], t: spoil(shown, start, end) } });
}

export function removeQuote(key: string): void {
  commit({ ...edits, [key]: { ...edits[key], del: true } });
}

export function resetEdits(): void {
  commit({});
}

/** Step back one edit. Only this browser can, since only it kept the original. */
export function undo(): boolean {
  const prev = undoStack.pop();
  if (!prev) return false;
  edits = prev;
  try {
    localStorage.setItem(KEY, JSON.stringify(edits));
  } catch {
    // See commit().
  }
  return true;
}

/** Split text into plain and spoiler parts for rendering. */
export const parts = (text: string): { s: string; hidden: boolean }[] =>
  text.split(/(█+)/).filter(Boolean).map((s) => ({ s, hidden: /^█+$/.test(s) }));
