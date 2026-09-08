import type { MetricKey } from "./types.js";

export interface MetricDef {
  key: MetricKey;
  label: string;
  explain: string;
  unit?: string;
  /** Main metrics lead the menu; the rest are the long tail. */
  main?: boolean;
  /** Event-shaped, so it can be laid over another metric as gold cells. */
  overlay?: boolean;
  /** Daily values are medians, which cannot be summed when machines merge. */
  median?: boolean;
}

export const METRICS: MetricDef[] = [
  { key: "prompts", label: "Prompts", explain: "every prompt you submitted, by day", main: true },
  { key: "godPrompts", label: "God prompts", explain: "prompts over 5,000 characters — about 750 words, or two printed pages", main: true, overlay: true },
  { key: "leash", label: "Leash", explain: "median minutes between your prompts — short is steering, long is delegating", unit: "min", main: true, median: true },
  { key: "autonomy", label: "Autonomy", explain: "hours the agent kept working while you were away", unit: "h", main: true },
  { key: "promptWords", label: "Prompt length", explain: "median words per prompt that day", unit: "words", median: true },
  { key: "nudges", label: "Nudges", explain: '"yes", "continue", "try again" — 25 characters or fewer' },
  { key: "specShaped", label: "Spec-shaped", explain: "prompts written as a bulleted or numbered list" },
  { key: "overnight", label: "Overnight", explain: "you handed work over late and reviewed it the next morning", overlay: true },
  { key: "nightOwl", label: "Night owl", explain: "prompts sent between 22:00 and 05:00", overlay: true },
  { key: "politeness", label: "Politeness", explain: 'prompts where you said "please" to a language model' },
];

export const byKey = (k: MetricKey): MetricDef => METRICS.find((m) => m.key === k)!;
