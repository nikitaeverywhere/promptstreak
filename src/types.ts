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
  | "medianLength"
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
  stats: Stats;
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
  maxLength: number;
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
}
