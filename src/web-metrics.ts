import type { MetricKey } from "./types.js";

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** One line, sentence case — it is shown as the card subtitle and in the menu. */
  explain: string;
  unit?: string;
  main?: boolean;
  /** Event-shaped, so it can be laid over another metric. */
  overlay?: boolean;
  /** Daily values are medians, which cannot be summed when machines merge. */
  median?: boolean;
  /** Night things are purple, not green or gold. */
  night?: boolean;
}

export const METRICS: MetricDef[] = [
  { key: "prompts", label: "Prompts", explain: "Every prompt you submitted, by day", main: true },
  { key: "godPrompts", label: "God prompts", explain: "Prompts over 5,000 characters — about two printed pages", main: true, overlay: true },
  { key: "leash", label: "Leash", explain: "Median minutes between prompts — short is steering, long is delegating", unit: "min", main: true, median: true },
  { key: "autonomy", label: "Autonomy", explain: "Hours the agent kept working while you were away", unit: "h", main: true },
  { key: "promptWords", label: "Prompt length", explain: "Median words per prompt", unit: "words", median: true },
  { key: "nudges", label: "Nudges", explain: "Prompts of 25 characters or fewer — yes, continue, try again" },
  { key: "specShaped", label: "Spec-shaped", explain: "Prompts written as a bulleted or numbered list" },
  { key: "overnight", label: "Overnight", explain: "Work handed over late and reviewed the next morning", overlay: true, night: true },
  { key: "nightOwl", label: "Night owl", explain: "Prompts sent between 22:00 and 05:00", overlay: true, night: true },
  { key: "politeness", label: "Politeness", explain: "Prompts where you said please", },
];

export const byKey = (k: MetricKey): MetricDef => METRICS.find((m) => m.key === k)!;
