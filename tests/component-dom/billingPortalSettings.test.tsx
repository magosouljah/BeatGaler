// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  account: vi.fn(), plan: vi.fn(), catalog: vi.fn(), available: vi.fn(), open: vi.fn(),
}));
vi.mock("../../src/components/AccountGate", () => ({
  beginMfaSetup: vi.fn(), changeBeatGalerEmail: vi.fn(), changeBeatGalerPassword: vi.fn(),
  disableMfa: vi.fn(), disconnectOAuthProvider: vi.fn(), enableMfa: vi.fn(),
  getBeatGalerAccountInfo: api.account, getBeatGalerCurrentPlan: api.plan,
  getBeatGalerPlanCatalog: api.catalog, startBeatGalerCheckout: vi.fn(),
  oauthBeatGalerAccount: vi.fn(),
}));
vi.mock("../../src/components/billingPortal", () => ({
  beatGalerPortalAvailable: api.available, openBeatGalerPortal: api.open,
}));

import SettingsPanel from "../../src/components/SettingsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const plan = {
  base_plan_id: "paid_entry", effective_plan_id: "paid_entry", label: "Paid Entry",
  initial_checkout_allowed: false, effective_until: null,
  quotas: { max_beats: 100, max_project_zip_bytes: 1_000_000_000 },
  entitlements: { upload_project: true, early_access: false },
  access: { commercialPlanId: "paid_entry", commercialAccessPlanId: "paid_entry", commercialAccessState: "paid",
    billing: { paidThrough: null, graceUntil: null, cancelAtPeriodEnd: false, nextPlanId: null, nextPlanEffectiveAt: null } },
};
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
  };
  return { host, click, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("Web subscriber management", () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    window.history.replaceState(null, "", "/");
    api.account.mockResolvedValue({ id: "user", username: "user", providers: {}, plan });
    api.plan.mockResolvedValue(plan);
    api.catalog.mockResolvedValue([]);
    api.available.mockResolvedValue(true);
    api.open.mockRejectedValue(new Error("provider private detail"));
  });

  it("shows management for a server-confirmed subscriber and keeps current Access on portal return", async () => {
    window.history.replaceState(null, "", "/?billing=portal-return");
    const view = await mount(); await view.click("plan");
    expect(view.host.textContent).toContain("Manage subscription");
    expect(view.host.textContent).toContain("Subscriber management returned");
    expect(view.host.querySelector('[data-testid="settings-current-plan"]')?.textContent).toBe("Paid Entry");
    expect(window.location.search).toBe("");
    await view.click("Manage subscription");
    expect(api.open).toHaveBeenCalledOnce();
    expect(view.host.textContent).toContain("Subscriber management could not be opened");
    expect(view.host.textContent).not.toContain("provider private detail");
    await view.close();
  });

  it("hides management when availability fails closed", async () => {
    api.available.mockRejectedValue(new Error("unavailable"));
    const view = await mount(); await view.click("plan");
    expect(view.host.textContent).not.toContain("Manage subscription");
    expect(view.host.textContent).toContain("Subscriber management is currently unavailable");
    expect(api.open).not.toHaveBeenCalled();
    await view.close();
  });
});
