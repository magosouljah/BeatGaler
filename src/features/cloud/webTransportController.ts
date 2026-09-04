import {
  activateWebTransportSession,
  authorizeWebTransportOperation,
  beginWebTransportOperation,
  bindWebTransportSession,
  endWebTransportOperation,
  heartbeatWebTransportSession,
  reserveWebTransportSession,
  stopWebTransportSession,
  type WebTransportCapabilityScope,
  type WebTransportSession,
  type WebTransportSessionPublic,
} from "./webTransportSession";
import { playTrace, observePlayStep } from "../playback/playTrace";

export interface WebTransportRuntime {
  initialize(session: WebTransportSession): Promise<void>;
  replaceCredentials(session: WebTransportSession): Promise<void>;
  verifyReady(session: WebTransportSession): Promise<void>;
  shutdown(): Promise<void>;
}

export interface WebTransportControlApi {
  reserve(startupBeatIds?: readonly string[]): Promise<WebTransportSessionPublic>;
  bind(bootstrap: WebTransportSessionPublic): Promise<WebTransportSession>;
  activate(session: WebTransportSessionPublic): Promise<void>;
  heartbeat(session: WebTransportSession): Promise<{ expired: boolean; credentialRefresh: WebTransportSession | null }>;
  authorize(session: WebTransportSession, operationId: string, kind: string, scope: WebTransportCapabilityScope): Promise<void>;
  begin(session: WebTransportSession, kind: string, scope: WebTransportCapabilityScope): Promise<{
    expired: boolean;
    waitMs: number | null;
    credentialRefresh: WebTransportSession | null;
    operationId: string | null;
  }>;
  end(session: Pick<WebTransportSession, "session_id" | "generation">, operationId: string): Promise<void>;
  stop(session: Pick<WebTransportSessionPublic, "session_id" | "generation">): Promise<void>;
}

export interface WebTransportOperationLease {
  operationId: string;
  sessionId: string;
  generation: number;
  scope: WebTransportCapabilityScope;
}

const defaultApi: WebTransportControlApi = {
  reserve: reserveWebTransportSession,
  bind: bindWebTransportSession,
  activate: activateWebTransportSession,
  authorize: authorizeWebTransportOperation,
  heartbeat: heartbeatWebTransportSession,
  begin: beginWebTransportOperation,
  end: endWebTransportOperation,
  stop: stopWebTransportSession,
};

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const MAX_STARTUP_BEATS = 14;

type StartupBranchResult =
  | { ok: true }
  | { ok: false; error: unknown };

async function settleStartupBranch(work: Promise<void>): Promise<StartupBranchResult> {
  try {
    await work;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeStartupBeatIds(values: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= MAX_STARTUP_BEATS) break;
  }
  return output;
}

/** Owns the Web lease. Credentials remain in memory and are handed only to the data-plane runtime. */
export class WebTransportController {
  private session: WebTransportSession | null = null;
  private connectPromise: Promise<WebTransportSession> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private startupBeatIds: string[] = [];

  constructor(
    private readonly runtime: WebTransportRuntime,
    private readonly api: WebTransportControlApi = defaultApi,
  ) {}

  configureStartupBeatIds(beatIds: readonly string[]): void {
    if (this.session || this.connectPromise) {
      playTrace("CONTROLLER_STARTUP_IDS_LATE", { count: beatIds.length });
      return;
    }
    this.startupBeatIds = normalizeStartupBeatIds(beatIds);
    playTrace("CONTROLLER_STARTUP_IDS_CONFIGURED", { count: this.startupBeatIds.length });
  }

  async connect(): Promise<WebTransportSession> {
    if (this.closed) throw new Error("Galer Cloud Web transport is closed.");
    if (this.refreshPromise) {
      playTrace("CONTROLLER_CONNECT_REFRESH_WAIT");
      await this.refreshPromise;
    }
    if (this.session) {
      playTrace("CONTROLLER_CONNECT_REUSE");
      return this.session;
    }
    if (this.connectPromise) {
      playTrace("CONTROLLER_CONNECT_JOIN");
      return this.connectPromise;
    }
    playTrace("CONTROLLER_CONNECT_NEW", { startup_beat_count: this.startupBeatIds.length });
    this.connectPromise = this.openSession().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async openSession(): Promise<WebTransportSession> {
    const started = Date.now();
    let bootstrap: WebTransportSessionPublic | null = null;
    let activationResultPromise: Promise<StartupBranchResult> | null = null;

    playTrace("CONTROLLER_SESSION_PREPARE_BEGIN", { startup_beat_count: this.startupBeatIds.length });
    try {
      // Reserve first so TypeScript and teardown both have an explicit lease.
      // Activation then overlaps only with temp-auth creation/binding; Worker
      // initialize (which contains startup getMessages) remains gated below.
      bootstrap = await this.api.reserve(this.startupBeatIds);
      const activateStarted = Date.now();
      activationResultPromise = settleStartupBranch(
        observePlayStep("DIRECT_ACTIVATE", () => this.api.activate(bootstrap!)),
      ).then(result => {
        if (result.ok) {
          playTrace("CONTROLLER_SESSION_ACTIVATE_DONE", { elapsed_ms: Date.now() - activateStarted });
        }
        return result;
      });

      const session = await observePlayStep("DIRECT_PREPARE", () => this.api.bind(bootstrap!));
      playTrace("CONTROLLER_SESSION_PREPARE_DONE", {
        elapsed_ms: Date.now() - started,
        startup_routes: Object.keys(session.startup_routes || {}).length,
        routing_revision: Math.max(0, Number(session.routing_revision) || 0),
      });

      // Important ordering invariant: getMessages(startup routes) runs inside
      // runtime.initialize(). Do not race that RPC against vault membership.
      const activationResult = await activationResultPromise;
      if (!activationResult.ok) throw activationResult.error;
      playTrace("CONTROLLER_SESSION_MEDIA_GATE_OPEN");

      const initializeStarted = Date.now();
      const initializeResult = await settleStartupBranch(
        observePlayStep("DIRECT_INITIALIZE", () => this.runtime.initialize(session)),
      );
      if (!initializeResult.ok) throw initializeResult.error;
      playTrace("CONTROLLER_SESSION_INITIALIZE_DONE", { elapsed_ms: Date.now() - initializeStarted });

      // getChat remains the explicit vault-membership check until the negative
      // getMessages-without-membership probe proves Telegram's error is unambiguous.
      const verifyStarted = Date.now();
      await observePlayStep("DIRECT_VERIFY", () => this.runtime.verifyReady(session));
      playTrace("CONTROLLER_SESSION_VERIFY_DONE", { elapsed_ms: Date.now() - verifyStarted });
      this.session = session;
      playTrace("CONTROLLER_SESSION_READY", { total_ms: Date.now() - started });
      this.scheduleHeartbeat(session.heartbeat_interval_ms);
      return session;
    } catch (error) {
      if (activationResultPromise) await activationResultPromise;
      await this.runtime.shutdown().catch(() => {});
      if (bootstrap) await this.api.stop(bootstrap).catch(() => {});
      throw error;
    }
  }

  private scheduleHeartbeat(milliseconds: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.closed || !this.session) return;
    const delay = Math.max(1000, Number(milliseconds) || 60_000);
    this.heartbeatTimer = setTimeout(() => { void this.sendHeartbeat(); }, delay);
  }

  private async sendHeartbeat(): Promise<void> {
    const session = this.session;
    if (!session || this.closed) return;
    try {
      const response = await this.api.heartbeat(session);
      if (response.expired) {
        await this.resetLocalSession();
        return;
      }
      if (response.credentialRefresh) await this.applyCredentialRefresh(response.credentialRefresh);
      this.scheduleHeartbeat(this.session?.heartbeat_interval_ms || session.heartbeat_interval_ms);
    } catch {
      this.scheduleHeartbeat(Math.min(5000, session.heartbeat_interval_ms));
    }
  }

  private async applyCredentialRefresh(session: WebTransportSession): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = (async () => {
      playTrace("CONTROLLER_CREDENTIAL_REFRESH_BEGIN");
      try {
        await this.runtime.replaceCredentials(session);
        await this.runtime.verifyReady(session);
        this.session = session;
        playTrace("CONTROLLER_CREDENTIAL_REFRESH_READY");
      } catch (error) {
        playTrace("CONTROLLER_CREDENTIAL_REFRESH_FAILED", {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.session = null;
        await this.runtime.shutdown().catch(() => {});
        throw error;
      }
    })();
    this.refreshPromise = refresh.finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async resetLocalSession(): Promise<void> {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.session = null;
    await this.runtime.shutdown().catch(() => {});
  }

  async beginOperation(kind: string, scope: WebTransportCapabilityScope): Promise<WebTransportOperationLease> {
    const deadline = Date.now() + 120_000;
    while (!this.closed && Date.now() < deadline) {
      const session = await this.connect();
      if (this.refreshPromise) {
        await this.refreshPromise;
        continue;
      }
      const response = await this.api.begin(session, kind, scope);
      if (response.expired) {
        await this.resetLocalSession();
        continue;
      }
      if (response.credentialRefresh) {
        await this.applyCredentialRefresh(response.credentialRefresh);
        continue;
      }
      if (response.waitMs !== null) {
        playTrace("CONTROLLER_OPERATION_WAIT", { kind, wait_ms: response.waitMs });
        await wait(response.waitMs);
        continue;
      }
      if (response.operationId) {
        try {
          await this.api.authorize(session, response.operationId, kind, scope);
        } catch (error) {
          await this.api.end({ session_id: session.session_id, generation: session.generation }, response.operationId).catch(() => {});
          throw error;
        }
        return {
          operationId: response.operationId,
          sessionId: session.session_id,
          generation: session.generation,
          scope,
        };
      }
      throw new Error("Galer Cloud returned incomplete operation information.");
    }
    throw new Error("Galer Cloud is still waiting for another transfer to finish.");
  }

  async endOperation(lease: WebTransportOperationLease): Promise<void> {
    await this.api.end({ session_id: lease.sessionId, generation: lease.generation }, lease.operationId);
  }

  async withOperation<T>(kind: string, scope: WebTransportCapabilityScope, operation: () => Promise<T>): Promise<T> {
    const lease = await this.beginOperation(kind, scope);
    try {
      return await operation();
    } finally {
      await this.endOperation(lease).catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const refresh = this.refreshPromise;
    if (refresh) await refresh.catch(() => {});
    const session = this.session;
    this.session = null;
    await this.runtime.shutdown().catch(() => {});
    if (session) await this.api.stop(session).catch(() => {});
  }
}
