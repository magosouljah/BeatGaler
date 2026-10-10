// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  account: vi.fn(), plan: vi.fn(), catalog: vi.fn(), checkout: vi.fn(),
}));
vi.mock("../../src/components/AccountGate", () => ({
  beginMfaSetup: vi.fn(), changeBeatGalerEmail: vi.fn(), changeBeatGalerPassword: vi.fn(),
  disableMfa: vi.fn(), disconnectOAuthProvider: vi.fn(), enableMfa: vi.fn(),
  getBeatGalerAccountInfo: api.account, getBeatGalerCurrentPlan: api.plan,
  getBeatGalerPlanCatalog: api.catalog, startBeatGalerCheckout: api.checkout,
  devSwitchBeatGalerPlan: vi.fn(), oauthBeatGalerAccount: vi.fn(),
}));

import SettingsPanel from "../../src/components/SettingsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const catalog = [
  { id: "free", label: "Free", price: { amount_minor: 0, currency: "usd", interval: null, offer_id: null }, entitlements: { upload_project: false, early_access: false }, quotas: { max_beats: 20, max_project_zip_bytes: 0 } },
  { id: "paid_entry", label: "Paid Entry", checkout_available: true, price: { amount_minor: 699, currency: "usd", interval: "month", offer_id: "entry" }, entitlements: { upload_project: true, early_access: false }, quotas: { max_beats: 100, max_project_zip_bytes: 1_000_000_000 } },
  { id: "highest_paid", label: "Highest Paid", checkout_available: true, price: { amount_minor: 1199, currency: "usd", interval: "month", offer_id: "highest" }, entitlements: { upload_project: true, early_access: true }, quotas: { max_beats: null, max_project_zip_bytes: 1_900_000_000 } },
];
function plan(id = "free", initialCheckoutAllowed = true) {
  const definition = catalog.find(item => item.id === id)!;
  return { effective_plan_id: id, base_plan_id: id, label: definition.label, initial_checkout_allowed: initialCheckoutAllowed,
    quotas: definition.quotas, entitlements: definition.entitlements, effective_until: null,
    access: { commercialPlanId: id, commercialAccessPlanId: id === "free" ? null : id, commercialAccessState: id === "free" ? "none" : "paid",
      billing: { paidThrough: null, graceUntil: null, cancelAtPeriodEnd: false, nextPlanId: null, nextPlanEffectiveAt: null } } };
}
const props = { currentFolder: null, showIncompleteWarnings: true, onIncompleteWarningsChanged: () => {}, customCursorEnabled: true,
  onCustomCursorChanged: () => {}, telegramConnected: true, networkOnline: true, telegramUsername: null,
  onDisconnectTelegram: async () => {}, onClose: () => {}, onFolderChanged: () => {} };

async function mount() {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<SettingsPanel {...props}/>); await Promise.resolve(); });
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent?.trim() === label);
    expect(button, label).toBeTruthy();
    await act(async () => { button!.click(); await Promise.resolve(); });
    return button!;
  };
  return { host, click, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("Settings commercial truth", () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    window.history.replaceState(null, "", "/");
    api.catalog.mockResolvedValue(catalog);
    api.plan.mockResolvedValue(plan());
    api.account.mockResolvedValue({ id: "user", username: "user", providers: {}, plan: plan() });
    api.checkout.mockRejectedValue(new Error("provider secret error"));
  });

  it.each(["free", "paid_entry", "highest_paid"])("shows %s as current from /plans/me", async id => {
    api.plan.mockResolvedValue(plan(id));
    api.account.mockResolvedValue({ id: "user", username: "user", providers: {}, plan: plan(id) });
    const view = await mount();
    expect(view.host.querySelector('[data-testid="account-current-plan"]')?.textContent).toBe(catalog.find(item => item.id === id)!.label);
    await view.click("plan");
    expect(view.host.querySelector('[data-testid="settings-current-plan"]')?.textContent).toBe(catalog.find(item => item.id === id)!.label);
    expect(view.host.querySelectorAll("button:disabled")).toBeTruthy();
    expect(view.host.textContent).toContain("USD 6.99 / month");
    expect(view.host.textContent).toContain("USD 11.99 / month");
    expect(view.host.textContent).not.toMatch(/Annual|YouTube|Bulk|product_id|price_id/);
    await view.close();
  });

  it("does not grant Paid from a checkout redirect and keeps retry id stable", async () => {
    window.history.replaceState(null, "", "/?billing=success");
    const view = await mount(); await view.click("plan");
    expect(view.host.textContent).toContain("Checkout returned");
    expect(view.host.textContent).toContain("Free");
    await view.click("Choose plan");
    expect(api.checkout).toHaveBeenCalledTimes(1);
    expect(view.host.textContent).toContain("Checkout could not be opened");
    expect(view.host.textContent).not.toContain("provider secret error");
    await view.click("Choose plan");
    expect(api.checkout.mock.calls[0][1]).toBe(api.checkout.mock.calls[1][1]);
    await view.close();
  });

  it("fails closed when plan or catalog requests fail", async () => {
    api.plan.mockRejectedValue(new Error("offline")); api.catalog.mockRejectedValue(new Error("offline"));
    const view = await mount(); await view.click("plan");
    expect(view.host.textContent).toContain("Plan unavailable");
    expect(view.host.textContent).toContain("Plan catalog unavailable");
    expect(view.host.textContent).not.toContain("USD 6.99");
    await view.close();
  });

  it("blocks initial checkout for an existing subscriber", async () => {
    api.plan.mockResolvedValue(plan("paid_entry", false));
    const view = await mount(); await view.click("plan");
    expect(view.host.textContent).toContain("Subscription changes are not yet available in Web");
    expect(api.checkout).not.toHaveBeenCalled();
    await view.close();
  });

  it("disables checkout when the validated provider is unavailable", async () => {
    api.catalog.mockResolvedValue(catalog.map(item => ({ ...item, checkout_available: false })));
    const view = await mount(); await view.click("plan");
    expect(view.host.textContent).toContain("Checkout unavailable");
    expect(api.checkout).not.toHaveBeenCalled();
    await view.close();
  });

  it("shows pending and grace without promoting the future plan", async () => {
    const entry = plan("paid_entry", false);
    const state = { ...entry, access: { ...entry.access, commercialAccessState: "grace",
      billing: { ...entry.access.billing, graceUntil: Date.UTC(2026, 9, 31), nextPlanId: "highest_paid", nextPlanEffectiveAt: Date.UTC(2026, 10, 1) } } };
    api.plan.mockResolvedValue(state);
    api.account.mockResolvedValue({ id: "user", username: "user", providers: {}, plan: state });
    const view = await mount(); await view.click("plan");
    expect(view.host.querySelector('[data-testid="settings-current-plan"]')?.textContent).toBe("Paid Entry");
    expect(view.host.textContent).toContain("Payment issue");
    expect(view.host.textContent).toContain("Scheduled: Highest Paid");
    await view.close();
  });
});
