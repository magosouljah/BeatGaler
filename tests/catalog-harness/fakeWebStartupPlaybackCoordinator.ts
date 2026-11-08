// T02 / V01-B — Doble de src/features/playback/webStartupPlaybackCoordinator.ts para el harness de navegador.
// Base: doble aprobado del smoke T00/G0 (G0-REVISION-FINAL-v2.zip). Nunca abre MTProto/Telegram.
// La Gallery LOCAL actual (pre-T08) lee metadata por la ruta legacy getLibraryIndex: aquí se sirve el
// fixture T01 c12-f02-search (241 beats, schema real) desde el servidor fake de 127.0.0.1 y la llamada
// queda contada como lectura legacy. downloadFiles (media/artwork) devuelve null y se cuenta.
// Cualquier método no implementado falla y se registra: un contrato ausente no pasa en silencio.

const FIXTURE_ID = "c12-f02-search";
const calls: string[] = [];
const record = (name: string) => { calls.push(name); (window as any).__catalogHarnessCalls = calls; };

class FakeTransport {
  async getLibraryIndex() {
    record("transport.getLibraryIndex(legacy-metadata)");
    const response = await fetch(`/beatgaler-api/__catalog/fixtures/${FIXTURE_ID}`, { credentials: "include" });
    if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
    const doc = await response.json();
    return { messageId: 900, manifest: doc.index ?? doc };
  }
  async downloadFiles(inputs: unknown[]) { record("transport.downloadFiles"); return inputs.map(() => null); }
  async disconnect() { record("transport.disconnect"); }
}

class FakeSources {
  prefetch() { record("sources.prefetch"); return Promise.resolve(); }
  setPrefetchPriority() { record("sources.setPrefetchPriority"); }
  async prepare() { record("sources.prepare"); throw new Error("V01B_NO_AUDIO"); }
  updatePlaybackState() { record("sources.updatePlaybackState"); }
  release() { record("sources.release"); }
  forget() { record("sources.forget"); }
  releaseAll() { record("sources.releaseAll"); }
  cacheStatus() { return { used_bytes: 0, limit_mb: 100 }; }
  setCacheLimitMb(limitMb: number) { return { used_bytes: 0, limit_mb: Math.max(0, Math.round(limitMb)) }; }
  clearCache() { return { used_bytes: 0, limit_mb: 100 }; }
}

function strict<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj || typeof prop === "symbol" || prop === "then") return Reflect.get(obj, prop, receiver);
      record(`UNSUPPORTED ${label}.${String(prop)}`);
      return () => Promise.reject(new Error(`V01B_FAKE_UNSUPPORTED ${label}.${String(prop)}`));
    },
  });
}

export class WebStartupPlaybackCoordinator {
  private readonly transport = strict(new FakeTransport(), "transport");
  private readonly sources = strict(new FakeSources(), "sources");
  start() { record("coordinator.start"); return Promise.resolve(); }
  prepareConnection() { record("coordinator.prepareConnection"); return Promise.resolve(); }
  prepareSignIn() { record("coordinator.prepareSignIn"); return Promise.resolve(); }
  getTransport(): any { return this.transport; }
  getPlaybackSources(): any { return this.sources; }
  dispose() { record("coordinator.dispose"); }
}

let singleton: WebStartupPlaybackCoordinator | null = null;
export function getWebStartupPlaybackCoordinator(): WebStartupPlaybackCoordinator {
  if (!singleton) singleton = new WebStartupPlaybackCoordinator();
  return strict(singleton, "coordinator");
}
export async function disconnectWebStartupPlaybackCoordinator(): Promise<void> {
  const current = singleton; singleton = null; if (!current) return;
  current.dispose(); await current.getTransport().disconnect();
}
