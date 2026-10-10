import type { BeatGalerAccount, BeatGalerPlanDefinition, BeatGalerPlanId } from "./AccountGate";

export type CurrentPlan = NonNullable<BeatGalerAccount["plan"]>;

export function planName(id: BeatGalerPlanId, catalog: BeatGalerPlanDefinition[]): string {
  return catalog.find(plan => plan.id === id)?.label || id.replace(/_/g, " ");
}

export function planStatus(plan: CurrentPlan, catalog: BeatGalerPlanDefinition[]): string[] {
  const access = plan.access;
  if (!access) return plan.effective_until ? [`Access through ${date(plan.effective_until)}`] : [];
  const billing = access.billing;
  const lines: string[] = [];
  if (access.commercialAccessState === "grace" && access.commercialAccessPlanId === plan.effective_plan_id) {
    lines.push("Payment issue");
    if (billing.graceUntil) lines.push(`Your ${plan.label} access remains active during the grace period until ${date(billing.graceUntil)}.`);
  } else if (billing.cancelAtPeriodEnd && access.commercialAccessPlanId === plan.effective_plan_id && billing.paidThrough) {
    lines.push(`Canceled — access remains until ${date(billing.paidThrough)}`);
  } else if (plan.effective_plan_id !== "free" && plan.effective_until) {
    lines.push(`Access through ${date(plan.effective_until)}`);
  }
  if (billing.nextPlanId && billing.nextPlanId !== plan.effective_plan_id && access.commercialAccessPlanId === plan.effective_plan_id) {
    lines.push(`Scheduled: ${planName(billing.nextPlanId, catalog)}`);
    lines.push(billing.nextPlanEffectiveAt ? `Effective ${date(billing.nextPlanEffectiveAt)}` : "Effective next billing period");
  }
  return lines;
}

function date(value: number): string { return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }

export function planFeatures(plan: BeatGalerPlanDefinition): string[] {
  const features = [
    plan.quotas.max_beats === null ? "Unlimited beats" : `Up to ${plan.quotas.max_beats} beats`,
    plan.entitlements.upload_project && plan.quotas.max_project_zip_bytes != null
      ? `PROJECT uploads up to ${formatProjectBytes(plan.quotas.max_project_zip_bytes)}`
      : "New PROJECT uploads unavailable",
  ];
  if (plan.entitlements.early_access) features.push("Early Access included");
  return features;
}

export function formatProjectBytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}

export function planPrice(plan: BeatGalerPlanDefinition): string | null {
  if (!plan.price || plan.price.currency !== "usd") return null;
  if (plan.price.amount_minor === 0) return "$0";
  if (plan.price.interval !== "month") return null;
  return `USD ${(plan.price.amount_minor / 100).toFixed(2)} / month`;
}
