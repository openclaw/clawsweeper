const integer = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const int = (value: number) => integer.format(Math.round(value));
export const short = (value: number) => (Math.abs(value) >= 10_000 ? compact.format(value) : int(value));
export const pct = (value: number | null, digits = 1) => (value === null ? '–' : `${(value * 100).toFixed(digits)}%`);

export function delta(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1000) / 10;
  return { text: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`, sign: rounded > 0 ? 1 : rounded < 0 ? -1 : 0 };
}

export function duration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.round(hours / 24)}d`;
}

export function ago(iso: string, now: string) {
  const seconds = (Date.parse(now) - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  const days = Math.round(seconds / 86_400);
  return days < 60 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const stampFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
export const day = (iso: string) => dayFormat.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
export const stamp = (iso: string) => `${stampFormat.format(new Date(iso))} UTC`;

// snake_case enum values from the review schema, as short sentence-case labels.
const labels: Record<string, string> = {
  none: 'No recorded reason',
  keep_open: 'Keep open',
  implemented_on_main: 'Implemented on main',
  mostly_implemented_on_main: 'Mostly implemented',
  duplicate_or_superseded: 'Duplicate / superseded',
  low_signal_unmergeable_pr: 'Low-signal PR',
  not_actionable_in_repo: 'Not actionable here',
  cannot_reproduce: 'Cannot reproduce',
  stalled_unproven_pr: 'Stalled, unproven PR',
  stale_insufficient_info: 'Stale, insufficient info',
  author_pr_budget_exceeded: 'Author PR budget',
  unsponsored_feature_request: 'Unsponsored feature',
  unconfirmed_product_direction: 'Unconfirmed direction',
  oversized_pull_request: 'Oversized PR',
  obsolete_fix_pr: 'Obsolete fix',
  stale_version_bug: 'Stale version bug',
  abandoned_pr: 'Abandoned PR',
  reason_not_recorded: 'Reason not recorded',
  clawhub: 'ClawHub',
  not_applicable: 'Not applicable',
  mock_only: 'Mock only',
  needs_attention: 'Needs attention',
  security_boundary: 'Security boundary',
  product_direction: 'Product direction',
  merge_risk: 'Merge risk',
  proof_sufficiency: 'Proof sufficiency',
  manual_review: 'Manual review',
  release_inclusion: 'Release inclusion',
  scanner_refused: 'Scanner refused input',
  review_retry_exhausted: 'Retries exhausted',
  source_incompatible: 'Source incompatible',
  stale_revision: 'Stale revision',
  dispatch_debounce: 'Dispatch debounce',
  pull_request: 'PR',
  issue: 'Issue',
  provider_or_model: 'Provider / model',
  agent_input_scan: 'Input scan',
  source_preparation: 'Source preparation',
};

export function label(key: string) {
  if (labels[key]) return labels[key];
  const text = key.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
