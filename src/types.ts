/** One human prompt, as recorded by Claude Code. */
export interface PromptEvent {
  /** Epoch milliseconds. */
  ts: number;
  /** The prompt text exactly as submitted. */
  text: string;
  /** Absolute path of the project the prompt was sent from. */
  project: string;
  /** True for slash commands (`/model`, `/clear`, ...). */
  isSlash: boolean;
  /** True when the prompt carried pasted content. */
  pasted: boolean;
}

export type MetricKey =
  | "prompts"
  | "godPrompts"
  | "leash"
  | "promptWords"
  | "nudges"
  | "specShaped"
  | "autonomy"
  | "overnight"
  | "nightOwl"
  | "politeness";

export type Archetype = "Babysitter" | "Collaborator" | "Orchestrator";

export interface Metrics {
  /** First and last day with activity, `YYYY-MM-DD` in local time. */
  from: string;
  to: string;
  /** Every calendar day from `from` to `to`, inclusive. */
  days: string[];
  /** Per-metric arrays, index-aligned with `days`. */
  series: Record<MetricKey, number[]>;
  /**
   * Per-day counts behind the median metrics. A median cannot be merged from
   * another median, but with the counts two machines' days combine as a
   * prompt-weighted average instead of an average of averages.
   */
  aux: { leashN: number[]; typed: number[] };
  stats: Stats;
}

/** Real usage from transcripts — never estimated. Recent window only. */
export interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Transcripts are pruned, so this never spans the full grid. */
  fromDay: string;
  toDay: string;
  toolCalls: number;
  subagents: number;
}

export interface Stats {
  totalPrompts: number;
  typedPrompts: number;
  slashCommands: number;
  activeDays: number;
  spanDays: number;
  words: number;
  chars: number;
  medianLength: number;
  medianWords: number;
  maxLength: number;
  maxWords: number;
  maxLengthDay: string;
  godPrompts: number;
  godPromptDays: number;
  nudges: number;
  nudgeRatio: number;
  specShaped: number;
  medianLeashMin: number;
  archetype: Archetype;
  /** `YYYY-MM` -> median leash in minutes. */
  leashByMonth: Record<string, number>;
  autonomyHours: number;
  /** Longest stretch you did not prompt while one session stayed alive. */
  longestUnattendedH: number;
  longestUnattendedAt: string;
  overnightHandoffs: number;
  overnightHours: number;
  longestStreak: number;
  longestStreakEnd: string;
  currentStreak: number;
  afterMidnight: number;
  medianDaySpanHours: number;
  /** 24 buckets, index = local hour. */
  byHour: number[];
  /** Project path -> prompt count, biggest first. */
  byProject: Array<[string, number]>;
  please: number;
  thanks: number;
  sorry: number;
  /** Most repeated short prompts, biggest first. */
  topNudges: Array<[string, number]>;
  /** Hostnames whose history is folded into this view. */
  machines: string[];
  tokens?: TokenStats;
}
