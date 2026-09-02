import { afterEach, describe, expect, it, vi } from "vitest";
import { readDirectStartupDiagnostics, startupCacheContext } from "../../src/features/perf/directStartupDiagnostics";
import { observePlayStep, playTrace } from "../../src/features/playback/playTrace";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Issue #97 Phase 1 diagnostics", () => {
  it("separates navigation, library cache and authoritative lease state", () => {
    vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "navigate" }] });
    expect(startupCacheContext("hit").startup_type).toBe("warm");
    expect(startupCacheContext("miss").startup_type).toBe("cold");
    expect(startupCacheContext("invalid").startup_type).toBe("unknown");
    vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "reload" }] });
    expect(startupCacheContext("hit")).toEqual({ navigation_type: "reload", startup_type: "reload" });
    expect(startupCacheContext("miss")).not.toHaveProperty("server_lease");
    vi.stubGlobal("performance", {});
    expect(startupCacheContext("hit")).toEqual({ navigation_type: "unknown", startup_type: "warm" });
  });

  it("correlates different realm origins without subtracting their local clocks", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("performance", { timeOrigin: 10_000, now: () => 1_200 });
    playTrace("MAIN");
    vi.stubGlobal("performance", { timeOrigin: 11_000, now: () => 250 });
    playTrace("WORKER");
    const entries = log.mock.calls.map(([line]) => JSON.parse(String(line).slice("[play-trace] ".length)));
    expect(entries[1].ts_ms - entries[0].ts_ms).toBe(50);
    expect(entries[1].t_ms - entries[0].t_ms).toBe(-950);
  });

  it("keeps operation results and exact errors when diagnostics fail", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logger failed"); });
    const result = {};
    await expect(observePlayStep("SUCCESS", async () => result)).resolves.toBe(result);
    const error = new Error("private-error-payload");
    await expect(observePlayStep("FAILURE", async () => { throw error; })).rejects.toBe(error);
  });

  it("drops secret and unexpected fields from the optional server header", () => {
    const result = readDirectStartupDiagnostics(JSON.stringify({
      request_id: "12345678-1234-1234-1234-123456789abc", outcome: "done", elapsed_ms: 125,
      token: "secret", session_id: "sensitive-id",
      events: [{ stage: "LEASE_SELECTED", server_lease: "reused", lease_state: "ACTIVE", auth_key: "secret" },
        { stage: "unexpected-secret", t_ms: 20 }],
    }));
    expect(result?.server_events).toHaveLength(1);
    expect(result?.server_events[0]).toMatchObject({ server_lease: "reused", lease_state: "ACTIVE" });
    expect(JSON.stringify(result)).not.toMatch(/secret|sensitive-id|auth_key/);
    expect(readDirectStartupDiagnostics(null)).toBeNull();
    expect(readDirectStartupDiagnostics("not-json")).toBeNull();
    expect(readDirectStartupDiagnostics("x".repeat(12_001))).toBeNull();
  });
});
