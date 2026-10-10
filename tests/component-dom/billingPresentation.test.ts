import { describe, expect, it } from "vitest";
import { planFeatures, planPrice, planStatus } from "../../src/components/billingPresentation";
import type { BeatGalerAccount, BeatGalerPlanDefinition } from "../../src/components/AccountGate";

const catalog: BeatGalerPlanDefinition[] = [
  { id: "free", label: "Free", price: { amount_minor: 0, currency: "usd", interval: null, offer_id: null }, entitlements: { upload_project: false, early_access: false }, quotas: { max_beats: 20, max_project_zip_bytes: 0 } },
  { id: "paid_entry", label: "Paid Entry", price: { amount_minor: 699, currency: "usd", interval: "month", offer_id: "entry" }, entitlements: { upload_project: true, early_access: false }, quotas: { max_beats: 100, max_project_zip_bytes: 1_000_000_000 } },
  { id: "highest_paid", label: "Highest Paid", price: { amount_minor: 1199, currency: "usd", interval: "month", offer_id: "highest" }, entitlements: { upload_project: true, early_access: true }, quotas: { max_beats: null, max_project_zip_bytes: 1_900_000_000 } },
];

type Plan = NonNullable<BeatGalerAccount["plan"]>;
const until = Date.UTC(2026, 9, 31);
function current(id: Plan["effective_plan_id"], overrides: Record<string, unknown> = {}): Plan {
  const definition = catalog.find(item => item.id === id)!;
  return {
    base_plan_id: id, effective_plan_id: id, label: definition.label, effective_until: id === "free" ? null : until,
    entitlements: { ...definition.entitlements, bulk_youtube_upload: "none" },
    quotas: { ...definition.quotas, youtube_uploads_per_day: null, youtube_uploads_per_month: null },
    access: {
      commercialPlanId: id, commercialAccessPlanId: id === "free" ? null : id,
      commercialAccessState: id === "free" ? "none" : "paid", effectivePlanId: id,
      capabilities: definition.entitlements, quotas: definition.quotas, accessSources: [], nextRecalculationAt: null,
      billing: { paidThrough: until, graceUntil: null, cancelAtPeriodEnd: false, nextPlanId: null, nextPlanEffectiveAt: null },
    }, ...overrides,
  };
}

describe("server-backed billing presentation", () => {
  it("renders Free, Entry and Highest limits, prices and Early Access from the catalog", () => {
    expect(catalog.map(planPrice)).toEqual(["$0", "USD 6.99 / month", "USD 11.99 / month"]);
    expect(planFeatures(catalog[0])).toEqual(["Up to 20 beats", "New PROJECT uploads unavailable"]);
    expect(planFeatures(catalog[1])).toEqual(["Up to 100 beats", "PROJECT uploads up to 1 GB"]);
    expect(planFeatures(catalog[2])).toEqual(["Unlimited beats", "PROJECT uploads up to 1.9 GB", "Early Access included"]);
    expect(planPrice({ ...catalog[1], price: undefined })).toBeNull();
    expect(catalog.map(plan => plan.id)).toEqual(["free", "paid_entry", "highest_paid"]);
  });

  it("keeps the current plan during cancellation, grace and a pending upgrade", () => {
    const entry = current("paid_entry");
    expect(planStatus(entry, catalog)).toEqual([expect.stringContaining("Access through")]);
    const canceled = current("paid_entry", { access: { ...entry.access!, billing: { ...entry.access!.billing, cancelAtPeriodEnd: true } } });
    expect(canceled.effective_plan_id).toBe("paid_entry");
    expect(planStatus(canceled, catalog)[0]).toContain("Canceled — access remains until");
    const grace = current("paid_entry", { access: { ...entry.access!, commercialAccessState: "grace", billing: { ...entry.access!.billing, graceUntil: until } } });
    expect(planStatus(grace, catalog)).toEqual(["Payment issue", expect.stringContaining("Paid Entry access remains active during the grace period")]);
    const pending = current("paid_entry", { access: { ...entry.access!, billing: { ...entry.access!.billing, nextPlanId: "highest_paid", nextPlanEffectiveAt: until } } });
    expect(pending.effective_plan_id).toBe("paid_entry");
    expect(planStatus(pending, catalog)).toContain("Scheduled: Highest Paid");
    expect(planStatus(current("free"), catalog)).toEqual([]);
  });
});
