// Browser persistence for the policy thresholds (see policy.ts for the values).

import { DEFAULT_RULES, type Rules } from "./policy.ts";

export { DEFAULT_RULES, type Rules };

const STORAGE_KEY = "ap_rules_v2";

export function loadRules(): Rules {
  if (typeof window === "undefined") return DEFAULT_RULES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RULES;
    return { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<Rules>) };
  } catch {
    return DEFAULT_RULES;
  }
}

export function saveRules(rules: Rules): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}
