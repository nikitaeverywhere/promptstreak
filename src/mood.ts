/**
 * Mood detectors. Pure functions over prompt text, shared by the CLI and the
 * page, so a "swear" means the same thing everywhere.
 *
 * Each detector returns an intensity, not a boolean: it drives both the daily
 * series (any intensity > 0 counts the prompt) and quote ranking (higher is
 * more quotable).
 */

export type Mood = "swearing" | "annoyed" | "caps" | "thanks" | "sorry" | "banter" | "ultrathink" | "goAhead" | "emoji";

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

// \b is ASCII-only in JavaScript, so the Cyrillic entries need real letter boundaries.
const SWEAR = /(?<![\p{L}\p{N}_])(fuck\w*|shit(?:ty|s|e)?|bullshit|dammit|damn\w*|crap\w*|bloody hell|ffs|pissed|asshole|bastard|retarded|bl[yj]a[dt]?\w*|бля\p{L}*|нахуй|пизд\p{L}+|сука|хер\p{L}*|ебан\p{L}*|заеб\p{L}*|чёрт|черт)(?![\p{L}\p{N}_])/giu;
// wtf (and its typo) is exasperation, not a swear word: it counts here, not above.
const STRONG_ANNOY = /\b(wtf|wft|why (did|do|would|the \w+ did) you|i (told|asked) you|you (broke|ignored|deleted|removed|undid|undoed|reverted|didn'?t listen)|for the (second|third|\d+\w*|last|nth) time|not what i (asked|wanted|said)|that'?s not what|seriously|come on|ugh+|are you (kidding|serious|retarded|dumb))\b/gi;
const PUNCT_ANNOY = /(!{2,}|\?{2,}|\?!|!\?)/g;
const WEAK_ANNOY = /\b(still (broken|wrong|not|doesn'?t|fails|missing)|again|wrong|nope|didn'?t work|doesn'?t work|not working)\b/gi;
const THANKS = /\b(thank(s| you)|thx|awesome|great (job|work)|well done|perfect|brilliant|love (it|this)|nice (work|one)|amazing|excellent|good job|impressive|fantastic|beautiful)\b/gi;
const THANKS_EMOJI = /🎉|👏|❤️|🙏|💚|🔥/g;
const SORRY = /\b(sorry|my bad|apologi[sz]e|apologies|oops|my mistake)\b/gi;
const BANTER = /\b(lol|lmao|haha+|hehe+|rofl|bro|dude|mate|buddy|my friend|good bot|you('re| are) the best|love you|xd)\b/gi;
const BANTER_EMOJI = /😂|🤣|😅|💀|🙃|😎|:D|;\)/g;
const ULTRA = /\b(ultrathink|think (hard|harder|deeply|step by step|carefully)|megathink)\b/gi;
const GO = /\b(go ahead|just do it|do it all|do (everything|all of it)|you decide|use your (best )?judg\w+|don'?t ask( me)?|without asking|no need to ask|make it happen)\b/gi;
const CAPS_WORD = /\b[A-Z]{4,}\b/g;
// Feelings only: faces, hands, hearts, party. Checkmarks, arrows, folders and
// the rest of the pictographic block are tooling, not mood, and stay out.
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F90C}-\u{1F93A}\u{1F970}-\u{1F97A}\u{1F9D0}\u{1FAE0}-\u{1FAE8}\u{1FAF0}-\u{1FAF8}\u{1F44A}-\u{1F450}\u{270A}-\u{270D}\u{2764}\u{1F493}-\u{1F49F}\u{1F5A4}\u{1F389}\u{1F38A}\u{1F525}\u{1F480}\u{1F4A9}\u{1F4AA}\u{1F440}\u{2728}\u{1F680}\u{1F4AF}\u{1F4A5}\u{1F31F}\u{2B50}\u{1F37B}\u{1F942}\u{1F4A4}]/gu;
// Text smileys and kaomoji, only as their own token so 10:30 and http:// stay clear.
const EMOTICON = /(?<!\S)(?::-?[()DPp|3]|;-?[()D]|=[()D]|<3|[xX][dD]|\^_*\^|-_-|[oO0]_+[oO0]|>_<|T_T|¯\\_\(ツ\)_\/¯|:'\()(?=$|[\s.,!?])/gmu;
/** Shouting, not shorthand. */
const ACRONYMS = new Set(["JSON", "HTML", "HTTP", "HTTPS", "README", "TODO", "SVG", "PNG", "JPEG", "GIF", "YAML", "TOML", "JSONL", "ASCII", "UTF", "CORS", "CSRF", "JWT", "OAUTH", "REST", "GRPC", "SDK", "MCP", "NPM", "NODE", "CSS", "SCSS", "MDX", "AWS", "GCP", "IDE", "SQL", "NULL", "TRUE", "FALSE", "ENUM", "UUID", "URL", "URLS", "API", "APIS", "CLI", "TTL", "DNS", "OIDC", "SASS", "VSCODE", "MACOS", "IOS", "LLM", "LLMS", "GPT", "OTP", "SEO", "PDF", "CSV", "XML", "WASM", "PROD", "DEV", "ENV", "LTS", "DOM"]);

const VOWEL = /[aeiouyаеёиоуыэюяії]/i;

/**
 * "fuck" -> "f*ck": one star on the first vowel after the opening letter, so
 * the word stays readable and screenshot-safe. Vowel-less abbreviations
 * (wtf, ffs) already censor themselves and are left alone.
 */
function star(word: string): string {
  const i = word.slice(1).search(VOWEL);
  return i < 0 ? word : word.slice(0, i + 1) + "*" + word.slice(i + 2);
}

/** Swear words starred out. Display only — the data underneath is untouched. */
export const censor = (text: string): string => text.replace(new RegExp(SWEAR.source, "giu"), star);

export const capsWords = (text: string): number =>
  (text.match(CAPS_WORD) ?? []).filter((w) => !ACRONYMS.has(w)).length;

export function moodScores(text: string): Record<Mood, number> {
  const caps = capsWords(text);
  const strong = count(text, STRONG_ANNOY) + count(text, PUNCT_ANNOY);
  const weak = count(text, WEAK_ANNOY);
  return {
    swearing: count(text, SWEAR),
    // A bare "doesn't work" is a bug report; annoyance needs a strong marker,
    // or two weak ones, or a weak one shouted.
    annoyed: strong > 0 ? strong + weak * 0.5 : weak >= 2 ? 1 : weak >= 1 && caps >= 1 ? 1 : 0,
    caps: caps >= 2 || (caps >= 1 && /!/.test(text)) ? caps : 0,
    thanks: count(text, THANKS) + count(text, THANKS_EMOJI),
    sorry: count(text, SORRY),
    banter: count(text, BANTER) + count(text, BANTER_EMOJI),
    ultrathink: count(text, ULTRA),
    goAhead: count(text, GO),
    emoji: count(text, EMOJI) + count(text, EMOTICON),
  };
}

/* ---------- quotes ---------- */

export interface Quote {
  /** The redacted text. */
  t: string;
  /** Which detector put it forward. */
  c: Mood;
  /** Local day. */
  d: string;
}

export const QUOTE_MAX = 10;
const QUOTE_MAX_CHARS = 200;

/**
 * Strip anything that could identify a project or leak a secret. This is a
 * floor, not a guarantee — the CLI shows the final list before it ships.
 */
export function redact(text: string): string {
  return text
    .replace(/\[(Image|Pasted text)[^\]]*\]/g, "")
    .replace(/https?:\/\/\S+/g, "‹link›")
    .replace(/(\/Users\/|\/home\/|[A-Za-z]:\\)\S+/g, "‹path›")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "‹email›")
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, "‹token›")
    .replace(/\b[0-9a-f]{20,}\b/gi, "‹hex›")
    .replace(/\s+/g, " ")
    .trim();
}

const quotable = (text: string): boolean =>
  !/```/.test(text) && text.length >= 8 && text.length <= QUOTE_MAX_CHARS;

const norm = (s: string) => s.toLowerCase().replace(/[^a-zа-яіїє0-9]+/gi, " ").trim();

/** Composite intensity used to rank quotes; swearing and shouting weigh most. */
export function quoteScore(scores: Record<Mood, number>, text: string): number {
  return (
    scores.swearing * 3 +
    scores.annoyed * 2 +
    scores.caps * 1 +
    scores.banter * 2 +
    scores.sorry * 1.5 +
    scores.thanks * 0.5 +
    scores.goAhead * 0.5 +
    scores.emoji * 1 -
    Math.max(0, text.length - 120) / 40
  );
}

export interface QuoteCandidate {
  text: string;
  ts: number;
  day: string;
  scores: Record<Mood, number>;
  score: number;
}

/**
 * Pick the quotes worth showing: two per category by intensity, then the best
 * of the rest, no near-duplicates. Recency only breaks ties — a great line
 * from March beats a mild one from yesterday.
 */
export function pickQuotes(cands: QuoteCandidate[], max = QUOTE_MAX): Quote[] {
  const out: Quote[] = [];
  const seen: string[] = [];
  const take = (c: QuoteCandidate, mood: Mood) => {
    const n = norm(c.text);
    if (seen.some((s) => s === n || s.startsWith(n) || n.startsWith(s))) return false;
    seen.push(n);
    out.push({ t: c.text, c: mood, d: c.day });
    return true;
  };
  const by = (mood: Mood) =>
    cands
      .filter((c) => c.scores[mood] > 0)
      .sort((a, b) => b.scores[mood] - a.scores[mood] || b.score - a.score || b.ts - a.ts);
  for (const mood of ["swearing", "caps", "annoyed", "banter", "sorry", "thanks", "emoji"] as Mood[]) {
    let got = 0;
    for (const c of by(mood)) {
      if (got >= 2 || out.length >= max) break;
      if (take(c, mood)) got++;
    }
  }
  const rest = [...cands].sort((a, b) => b.score - a.score || b.ts - a.ts);
  for (const c of rest) {
    if (out.length >= max) break;
    const mood = (Object.entries(c.scores) as [Mood, number][]).sort((a, b) => b[1] - a[1])[0][0];
    take(c, mood);
  }
  return out;
}

export const asCandidate = (text: string, ts: number, day: string): QuoteCandidate | null => {
  const clean = redact(text);
  if (!quotable(clean)) return null;
  const scores = moodScores(clean);
  if (!Object.values(scores).some((v) => v > 0)) return null;
  return { text: clean, ts, day, scores, score: quoteScore(scores, clean) };
};
