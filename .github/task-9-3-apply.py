from pathlib import Path
import os
import sys
import textwrap

APP = Path("src/App.tsx")
HOOK = Path("src/features/startup/useStartupBootstrap.ts")
COMPONENT_TEST = Path("tests/component-dom/startupBootstrap.test.tsx")
EXTRACTION_TEST = Path("tests/integration/appStartupBootstrapExtraction.test.ts")
CHAR_TEST = Path("tests/integration/appMigrationCharacterization.test.ts")
ROADMAP = Path("migration/BeatGaler-roadmap-para-trabajar-con-IAs.md")
REGISTRO = Path("migration/Registro-de-avance.md")
AGENT_STATE = Path("migration/BeatGaler-agent-state.md")
INITIAL_SHA = "18ad9a91f3a6207c652587509d27f4e3ee4907ca"


def apply():
    if HOOK.exists():
        raise SystemExit("useStartupBootstrap.ts already exists; refusing duplicate extraction")

    app = APP.read_text()
    notices = '''  const [interruptedUploadNotices, setInterruptedUploadNotices] = useState<string[]>([]);\n\n  useEffect(() => {\n    if (interruptedUploadNotices.length === 0) return;\n    const timer = window.setTimeout(() => setInterruptedUploadNotices([]), 15_000);\n    return () => window.clearTimeout(timer);\n  }, [interruptedUploadNotices]);\n\n'''
    if notices not in app:
        raise SystemExit("Could not locate startup recovery notice state")
    app = app.replace(notices, "", 1)

    start_marker = '  useEffect(() => {\n    let cancelled = false;\n\n    const showOfflineLibrary = async (state: ConnectionState) => {'
    end_marker = '\n  useEffect(() => {\n    if (!setupDone) return;'
    start = app.find(start_marker)
    end = app.find(end_marker, start + 1)
    if start < 0 or end < 0:
        raise SystemExit(f"Could not locate startup bootstrap block: start={start} end={end}")
    startup_block = textwrap.dedent(app[start:end]).replace(
        "dismissBeatGalerStartupLoader()", "dismissStartupLoader()"
    )

    hook_source = '''import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";\nimport type { AppSettings, Beat } from "../../types";\nimport { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";\nimport { libraryStateManager } from "../../lib/libraryStateManager";\nimport {\n  flushOfflineTrashIntents,\n  getSettings,\n  loadOfflineLibrary,\n  pollTelegramCloudStatus,\n  purgeInterruptedUploadLocal,\n  repairStaleCloudLibraryRefs,\n} from "../../lib/tauri";\nimport { readActiveCloudUploads, rollbackInterruptedCloudUploads } from "../cloud/interruptedUploadJournal";\nimport { cleanupOrphanedDropStaging } from "../dragdrop/dropStaging";\nimport { cloudBeatFingerprint } from "../library/libraryFingerprints";\nimport { preserveLoadedArtwork } from "../library/libraryPresentationCache";\nimport type { ConnectionState } from "../session/useSessionState";\n\nexport type StartupBootstrapOptions = {\n  startupCachedBeatsRef: MutableRefObject<Beat[] | null>;\n  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;\n  cloudLibrarySnapshotRef: MutableRefObject<string | null>;\n  startupCookingResolvedRef: MutableRefObject<boolean>;\n  startupPipelineStartedRef: MutableRefObject<boolean>;\n  startupEnginePrimeReadyRef: MutableRefObject<boolean>;\n  progressiveRevealRunRef: MutableRefObject<number>;\n  setBeats: Dispatch<SetStateAction<Beat[]>>;\n  setSettings: Dispatch<SetStateAction<AppSettings | null>>;\n  setSetupDone: Dispatch<SetStateAction<boolean>>;\n  setLoading: Dispatch<SetStateAction<boolean>>;\n  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;\n  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;\n  setStartupCookingGate: Dispatch<SetStateAction<boolean>>;\n  setRevealedBeatIds: Dispatch<SetStateAction<Set<string>>>;\n  clearReconciledTrashRuntimeStates: () => void;\n  dismissStartupLoader: () => void;\n};\n\nexport type StartupBootstrapController = {\n  interruptedUploadNotices: string[];\n  dismissInterruptedUploadNotices: () => void;\n};\n\nexport function useStartupBootstrap({\n  startupCachedBeatsRef,\n  cloudMetaSnapshotRef,\n  cloudLibrarySnapshotRef,\n  startupCookingResolvedRef,\n  startupPipelineStartedRef,\n  startupEnginePrimeReadyRef,\n  progressiveRevealRunRef,\n  setBeats,\n  setSettings,\n  setSetupDone,\n  setLoading,\n  setConnectionState,\n  setCloudSessionVerified,\n  setStartupCookingGate,\n  setRevealedBeatIds,\n  clearReconciledTrashRuntimeStates,\n  dismissStartupLoader,\n}: StartupBootstrapOptions): StartupBootstrapController {\n  const [interruptedUploadNotices, setInterruptedUploadNotices] = useState<string[]>([]);\n\n  useEffect(() => {\n    if (interruptedUploadNotices.length === 0) return;\n    const timer = window.setTimeout(() => setInterruptedUploadNotices([]), 15_000);\n    return () => window.clearTimeout(timer);\n  }, [interruptedUploadNotices]);\n\n''' + textwrap.indent(startup_block.rstrip(), "  ") + '''\n\n  const dismissInterruptedUploadNotices = useCallback(() => {\n    setInterruptedUploadNotices([]);\n  }, []);\n\n  return { interruptedUploadNotices, dismissInterruptedUploadNotices };\n}\n'''
    HOOK.parent.mkdir(parents=True, exist_ok=True)
    HOOK.write_text(hook_source)

    hook_call = '''  const { interruptedUploadNotices, dismissInterruptedUploadNotices } = useStartupBootstrap({\n    startupCachedBeatsRef,\n    cloudMetaSnapshotRef,\n    cloudLibrarySnapshotRef,\n    startupCookingResolvedRef,\n    startupPipelineStartedRef,\n    startupEnginePrimeReadyRef,\n    progressiveRevealRunRef,\n    setBeats,\n    setSettings,\n    setSetupDone,\n    setLoading,\n    setConnectionState,\n    setCloudSessionVerified,\n    setStartupCookingGate,\n    setRevealedBeatIds,\n    clearReconciledTrashRuntimeStates,\n    dismissStartupLoader: dismissBeatGalerStartupLoader,\n  });\n'''
    app = app[:start] + hook_call + app[end:]
    app = app.replace(
        'import { useLibraryReload } from "./features/library/useLibraryReload";\n',
        'import { useLibraryReload } from "./features/library/useLibraryReload";\nimport { useStartupBootstrap } from "./features/startup/useStartupBootstrap";\n',
        1,
    )
    app = app.replace(
        'import { readActiveCloudUploads, rollbackInterruptedCloudUploads } from "./features/cloud/interruptedUploadJournal";\n',
        '',
        1,
    )
    app = app.replace('useSessionState, type ConnectionState', 'useSessionState', 1)
    for token in ['loadOfflineLibrary, ', 'getSettings, ', 'repairStaleCloudLibraryRefs, ', 'purgeInterruptedUploadLocal, ']:
        app = app.replace(token, '', 1)
    app = app.replace('onClick={() => setInterruptedUploadNotices([])}', 'onClick={dismissInterruptedUploadNotices}', 1)
    APP.write_text(app)

    char = CHAR_TEST.read_text()
    char = char.replace(
        'const libraryReload = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryReload.ts"), "utf8");\n',
        'const libraryReload = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryReload.ts"), "utf8");\nconst startupBootstrap = readFileSync(resolve(process.cwd(), "src/features/startup/useStartupBootstrap.ts"), "utf8");\n',
        1,
    )
    char = char.replace(
        'expect(app).toContain("rollbackInterruptedCloudUploads({");',
        'expect(startupBootstrap).toContain("rollbackInterruptedCloudUploads({");\n    expect(app).toContain("useStartupBootstrap({");',
        1,
    )
    CHAR_TEST.write_text(char)

    EXTRACTION_TEST.write_text(r'''import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const startup = readFileSync("src/features/startup/useStartupBootstrap.ts", "utf8");
const main = readFileSync("src/main.tsx", "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing startup marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.3 startup bootstrap extraction", () => {
  it("moves the initial bootstrap owner out of App without taking reconnect or SSE", () => {
    expect(app).toContain('import { useStartupBootstrap } from "./features/startup/useStartupBootstrap";');
    expect(app).toContain("useStartupBootstrap({");
    expect(app).not.toContain("const showOfflineLibrary = async");
    expect(app).not.toContain("Telegram vault startup check failed:");
    expect(startup).toContain("const showOfflineLibrary = async");
    expect(startup).toContain("Telegram vault startup check failed:");
    expect(app).toContain("const reconnect = async () => {");
    expect(app).toContain("const connectEvents = async () => {");
  });

  it("preserves startup ordering and authority distinctions", () => {
    expectOrdered(startup, [
      "const local = await getSettings()",
      "status = await pollTelegramCloudStatus()",
      "readActiveCloudUploads().length > 0",
      "rollbackInterruptedCloudUploads({",
      "const flushedTrashCount = await flushOfflineTrashIntents()",
      "restored = await libraryStateManager.reloadAuthoritative()",
      "const repaired = await repairStaleCloudLibraryRefs()",
      "setBeats(current => preserveLoadedArtwork(",
      "setCloudSessionVerified(true)",
    ]);
    expect(startup).toContain("Authority is temporarily unknown, not empty.");
    expect(startup).toContain("if (!status.connected) {");
    expect(startup).toContain("setBeats([]);");
    expect(startup).toContain('setConnectionState("poor")');
  });

  it("keeps main.tsx initializers and root composition in place", () => {
    expect(main).toContain("installStartupTrace();");
    expect(main).toContain("installWebCsrfFetchCoordinator();");
    expect(main).toContain("preconnectRememberedWebDirect();");
    expect(main).toContain("<AuthExperienceGate>");
    expect(main).toContain("<LibraryUxBridge />");
    expect(main).toContain("<WebLibraryPagination />");
    expect(main).toContain("<App />");
  });
});
''')

    COMPONENT_TEST.write_text(r'''// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Beat } from "../../src/types";
import type { ConnectionState } from "../../src/features/session/useSessionState";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  loadOfflineLibrary: vi.fn(),
  pollTelegramCloudStatus: vi.fn(),
  flushOfflineTrashIntents: vi.fn(),
  purgeInterruptedUploadLocal: vi.fn(),
  repairStaleCloudLibraryRefs: vi.fn(),
  reloadAuthoritative: vi.fn(),
  readActiveCloudUploads: vi.fn(),
  rollbackInterruptedCloudUploads: vi.fn(),
  cleanupOrphanedDropStaging: vi.fn(),
  preserveLoadedArtwork: vi.fn(),
}));

vi.mock("../../src/components/AccountGate", () => ({
  getBeatGalerAuthToken: () => "token",
  getResolvedCloudApiBase: () => "http://cloud.test",
}));
vi.mock("../../src/lib/tauri", () => ({
  getSettings: mocks.getSettings,
  loadOfflineLibrary: mocks.loadOfflineLibrary,
  pollTelegramCloudStatus: mocks.pollTelegramCloudStatus,
  flushOfflineTrashIntents: mocks.flushOfflineTrashIntents,
  purgeInterruptedUploadLocal: mocks.purgeInterruptedUploadLocal,
  repairStaleCloudLibraryRefs: mocks.repairStaleCloudLibraryRefs,
}));
vi.mock("../../src/lib/libraryStateManager", () => ({
  libraryStateManager: { reloadAuthoritative: mocks.reloadAuthoritative },
}));
vi.mock("../../src/features/cloud/interruptedUploadJournal", () => ({
  readActiveCloudUploads: mocks.readActiveCloudUploads,
  rollbackInterruptedCloudUploads: mocks.rollbackInterruptedCloudUploads,
}));
vi.mock("../../src/features/dragdrop/dropStaging", () => ({
  cleanupOrphanedDropStaging: mocks.cleanupOrphanedDropStaging,
}));
vi.mock("../../src/features/library/libraryFingerprints", () => ({
  cloudBeatFingerprint: (beat: Beat) => `fp:${beat.id}`,
}));
vi.mock("../../src/features/library/libraryPresentationCache", () => ({
  preserveLoadedArtwork: mocks.preserveLoadedArtwork,
}));

import { useStartupBootstrap } from "../../src/features/startup/useStartupBootstrap";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latestBeats: Beat[] = [];
let latestConnection: ConnectionState = "checking";
let latestVerified = false;
let latestSetupDone = false;
let latestLoading = true;
let latestRevealed = new Set<string>();

function beat(id: string, cloud = true): Beat {
  return { id, name: id, tags: [], other_files: [], telegram_file_id: cloud ? `cloud-${id}` : undefined } as unknown as Beat;
}
const cached = beat("cached");
const remote = beat("remote");
const offline = beat("offline", false);
const settings: AppSettings = {
  beats_folder: null,
  incomplete_warnings_enabled: true,
  custom_cursor_enabled: true,
  beatgaler_user_id: "user-1",
  telegram_cloud_connected: true,
  telegram_cloud_username: "user",
};

function Harness({ initial }: { initial: Beat[] }) {
  const [beats, setBeats] = useState(initial);
  const [currentSettings, setSettings] = useState<AppSettings | null>(null);
  const [setupDone, setSetupDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connection, setConnectionState] = useState<ConnectionState>("checking");
  const [verified, setCloudSessionVerified] = useState(false);
  const [startupGate, setStartupCookingGate] = useState(initial.length === 0);
  const [revealed, setRevealedBeatIds] = useState<Set<string>>(() => new Set());
  const startupCachedBeatsRef = useRef<Beat[] | null>(initial);
  const cloudMetaSnapshotRef = useRef<Map<string, string> | null>(null);
  const cloudLibrarySnapshotRef = useRef<string | null>(null);
  const startupCookingResolvedRef = useRef(false);
  const startupPipelineStartedRef = useRef(false);
  const startupEnginePrimeReadyRef = useRef(false);
  const progressiveRevealRunRef = useRef(0);

  useStartupBootstrap({
    startupCachedBeatsRef,
    cloudMetaSnapshotRef,
    cloudLibrarySnapshotRef,
    startupCookingResolvedRef,
    startupPipelineStartedRef,
    startupEnginePrimeReadyRef,
    progressiveRevealRunRef,
    setBeats,
    setSettings,
    setSetupDone,
    setLoading,
    setConnectionState,
    setCloudSessionVerified,
    setStartupCookingGate,
    setRevealedBeatIds,
    clearReconciledTrashRuntimeStates: vi.fn(),
    dismissStartupLoader: () => document.getElementById("beatgaler-startup-loader")?.remove(),
  });

  latestBeats = beats;
  latestConnection = connection;
  latestVerified = verified;
  latestSetupDone = setupDone;
  latestLoading = loading;
  latestRevealed = revealed;
  void currentSettings;
  void startupGate;
  return <div>{beats.map(item => item.id).join(",")}</div>;
}

async function renderHarness(initial: Beat[], online = true) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness initial={initial} />); });
  await flushAsync();
}

async function flushAsync(rounds = 20) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue(settings);
  mocks.loadOfflineLibrary.mockReset().mockResolvedValue([]);
  mocks.pollTelegramCloudStatus.mockReset().mockResolvedValue({ connected: true, reachable: true, username: "user" });
  mocks.flushOfflineTrashIntents.mockReset().mockResolvedValue(0);
  mocks.purgeInterruptedUploadLocal.mockReset().mockResolvedValue(undefined);
  mocks.repairStaleCloudLibraryRefs.mockReset().mockResolvedValue(0);
  mocks.reloadAuthoritative.mockReset().mockResolvedValue([remote]);
  mocks.readActiveCloudUploads.mockReset().mockReturnValue([]);
  mocks.rollbackInterruptedCloudUploads.mockReset().mockResolvedValue([]);
  mocks.cleanupOrphanedDropStaging.mockReset().mockResolvedValue(undefined);
  mocks.preserveLoadedArtwork.mockReset().mockImplementation((incoming: Beat[]) => incoming);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.getElementById("beatgaler-startup-loader")?.remove();
});

describe("useStartupBootstrap", () => {
  it("loads authoritative beats on an online cold start without cache", async () => {
    await renderHarness([]);
    expect(latestBeats.map(item => item.id)).toEqual(["remote"]);
    expect(latestConnection).toBe("online");
    expect(latestVerified).toBe(true);
    expect(latestSetupDone).toBe(true);
    expect(latestLoading).toBe(false);
  });

  it("reveals only validated durable Offline beats on a cold offline start", async () => {
    mocks.loadOfflineLibrary.mockResolvedValue([offline]);
    await renderHarness([cached], false);
    expect(mocks.pollTelegramCloudStatus).not.toHaveBeenCalled();
    expect(latestBeats.map(item => item.id)).toEqual(["offline"]);
    expect(Array.from(latestRevealed)).toEqual(["offline"]);
    expect(latestConnection).toBe("offline");
    expect(latestVerified).toBe(false);
  });

  it("accepts an authoritative empty library instead of resurrecting cache", async () => {
    mocks.reloadAuthoritative.mockResolvedValue([]);
    await renderHarness([cached]);
    expect(latestBeats).toEqual([]);
    expect(latestVerified).toBe(true);
    expect(latestConnection).toBe("online");
  });

  it("preserves cached presentation when online authority stays temporarily unknown", async () => {
    mocks.reloadAuthoritative.mockRejectedValue(new Error("temporary authority failure"));
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 1;
    }) as typeof window.setTimeout);
    await renderHarness([cached]);
    await flushAsync();
    expect(mocks.reloadAuthoritative).toHaveBeenCalledTimes(3);
    expect(latestBeats.map(item => item.id)).toEqual(["cached"]);
    expect(latestConnection).toBe("poor");
    expect(latestVerified).toBe(false);
  });
});
''')


def close():
    implementation_sha = os.environ["IMPLEMENTATION_SHA"]
    pre_close_head = os.environ["PRE_CLOSE_HEAD"]
    run_id = os.environ.get("RUN_ID", os.environ.get("GITHUB_RUN_ID", "unknown"))

    roadmap = ROADMAP.read_text()
    pending = "### [ ] 9.3 — Separar el arranque inicial"
    done = "### [x] 9.3 — Separar el arranque inicial"
    if pending in roadmap:
        roadmap = roadmap.replace(pending, done, 1)
    elif done not in roadmap:
        raise SystemExit("Could not find roadmap task 9.3")
    ROADMAP.write_text(roadmap)

    registro = REGISTRO.read_text()
    if "### Registro — 9.3" in registro:
        raise SystemExit("Registro 9.3 already exists; refusing duplicate")
    entry = f'''### Registro — 9.3\n\n```\nTarea: 9.3 — Separar el arranque inicial\nEstado: Terminada\nFecha: 2026-09-09\n\nBase\n\n- Rama: v0.9.0-test-noche\n- SHA inicial de esta ejecución: {INITIAL_SHA}\n- SHA de implementación validada: {implementation_sha}\n- Última tarea verificada: 9.2 — Separar Reload\n\nCambio realizado\n\n- Se creó `src/features/startup/useStartupBootstrap.ts` como owner del bootstrap inicial: lectura de settings, verificación de conectividad Cloud, validación Offline, recuperación de uploads interrumpidos, flush de Trash offline, carga/reparación de autoridad y publicación inicial de biblioteca.\n- `App.tsx` dejó de poseer el efecto de arranque y el estado/timer de avisos de recuperación; ahora compone `useStartupBootstrap` y conserva solamente el render del aviso mediante el controller devuelto.\n- Se preservó el orden observable: settings → reachability/linkage → recuperación segura → Trash offline → autoridad con retry → reparación stale → publicación/verificación.\n- Caché de presentación, biblioteca vacía confirmada y autoridad desconocida siguen siendo estados distintos: el caché se mantiene ante fallo temporal de autoridad, pero un INDEX vacío confirmado sí publica `[]`.\n- El arranque offline valida primero `loadOfflineLibrary()` y revela únicamente paquetes durables.\n- `src/main.tsx` no fue modificado; `installStartupTrace`, CSRF coordinator, Direct preconnect y la composición raíz permanecen en su sitio.\n- Reconexión/SSE permanecen en App para 9.4 y revelado progresivo general permanece para 9.5.\n\nAdaptación de pruebas\n\n- Se añadió `tests/component-dom/startupBootstrap.test.tsx` con casos ejecutables para arranque online sin caché, cold start offline, autoridad vacía confirmada y fallo temporal de autoridad preservando caché.\n- Se añadió `tests/integration/appStartupBootstrapExtraction.test.ts` para ownership, orden y preservación de inicializadores de `main.tsx`.\n- `tests/integration/appMigrationCharacterization.test.ts` sigue la recuperación de uploads en el nuevo owner sin debilitar su contrato fail-closed.\n\nArchivos afectados\n\n- src/App.tsx\n- src/features/startup/useStartupBootstrap.ts\n- tests/component-dom/startupBootstrap.test.tsx\n- tests/integration/appStartupBootstrapExtraction.test.ts\n- tests/integration/appMigrationCharacterization.test.ts\n- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md\n- migration/Registro-de-avance.md\n- migration/BeatGaler-agent-state.md\n\nComprobaciones ejecutadas\n\n- GitHub Actions `Task 9.3 Apply`, run {run_id} — matriz focalizada, prepublicación y validación exacta del commit publicado.\n- Artifact `migration-check-logs-task-9-3-{run_id}` generado por la corrida.\n- Focalizadas de startup/extracción/caracterización — PASS.\n- `git diff --check` — PASS.\n- `npm run test:typecheck` — PASS.\n- `npm run test:unit:ts` — PASS.\n- `npm run test:component:dom` — PASS.\n- `npm run test:integration` — PASS.\n- `npm run test:regressions` — PASS.\n- `npm run build:web` — PASS.\n- `npm run build` — PASS.\n- Los checks exactos validaron `{implementation_sha}` después de publicarlo en la rama.\n\nComprobaciones no ejecutadas\n\n- `npm run check` no se ejecutó como wrapper; sus checks frontend aplicables se ejecutaron individualmente y ambos builds pasaron.\n- Prueba física Desktop/Web interactiva no ejecutada ni inventada; no queda como bloqueo porque los cuatro estados de aceptación de 9.3 están cubiertos por pruebas ejecutables más la matriz completa.\n\nPrueba manual\n\n- No ejecutada ni inventada.\n- Sugerida: abrir con caché válida, sin caché, sin red y con Cloud temporalmente inaccesible.\n- Resultado esperado: caché visible pero read-only hasta autoridad; INDEX vacío confirmado muestra galería vacía; offline muestra solo paquetes durables; fallo temporal no produce flash 60→0→60.\n\nPendientes / fuera de alcance\n\n- 9.4 — Separar reconexión y eventos cloud.\n- 9.5 — Separar la aparición de tarjetas.\n\nRiesgos previos relevantes\n\n- Ninguno nuevo de integridad identificado por 9.3.\n\nHerramientas temporales restantes\n\n- Ninguna. El workflow/applier temporal se elimina antes de publicar el SHA de implementación validada.\n\nFallos encontrados y causa\n\n- Ninguno en la corrida final; si existieron intentos previos fallidos de esta misma ronda, quedan identificables en GitHub Actions y no se usaron como evidencia de cierre.\n\nVeredicto\n\nTerminada.\n\nEl bootstrap inicial salió de App con los mismos estados de autoridad, caché y Offline y sin absorber reconexión/SSE ni revelado progresivo.\n\nSiguiente tarea\n\n9.4 — Separar reconexión y eventos cloud.\n\nNo iniciada.\n```\n'''
    sep = "" if registro.endswith("\n\n") else ("\n" if registro.endswith("\n") else "\n\n")
    REGISTRO.write_text(registro + sep + entry)

    AGENT_STATE.write_text(f'''# BeatGaler — Agent State\n\n## Contexto\n\n- Fecha de ejecución: 2026-09-09\n- Rama de trabajo: `v0.9.0-test-noche`\n- Tarea trabajada: `9.3 — Separar el arranque inicial`\n- Estado: `Terminada`\n- Última tarea terminada: `9.3 — Separar el arranque inicial`\n\n## Base de esta ejecución\n\n- SHA inicial: `{INITIAL_SHA}`\n- SHA de implementación validada: `{implementation_sha}`\n- HEAD remoto observado inmediatamente antes de la escritura final de agent-state: `{pre_close_head}`\n- Run de implementación final: `{run_id}` — `Task 9.3 Apply`.\n- Artifact final: `migration-check-logs-task-9-3-{run_id}`.\n- El SHA final real de la ronda se relee desde GitHub después de esta escritura y no se autorreferencia aquí.\n\n## Resultado verificado\n\n- `src/features/startup/useStartupBootstrap.ts` posee el bootstrap inicial, recuperación y avisos de uploads interrumpidos.\n- Settings, conectividad/linkage, recuperación, Trash offline, autoridad, reparación stale y publicación conservan su orden observable.\n- Arranque online sin caché, cold start offline, autoridad vacía confirmada y fallo temporal de autoridad están cubiertos por pruebas ejecutables.\n- Un fallo temporal conserva la presentación cacheada y deja la sesión Cloud no verificada; un INDEX vacío confirmado sí publica biblioteca vacía.\n- `main.tsx` permanece intacto.\n- Typecheck, unit TS, component DOM, integración, regresiones y builds Web/Desktop pasaron sobre `{implementation_sha}`.\n\n## Pendientes concretos\n\n- `9.4 — Separar reconexión y eventos cloud`.\n\n## Comprobaciones pendientes\n\n- Ninguna necesaria para cerrar 9.3.\n- Prueba física Desktop/Web no ejecutada ni inventada; no quedó como bloqueo por la cobertura automatizada de los estados exigidos.\n\n## Siguiente tarea\n\n- `9.4 — Separar reconexión y eventos cloud`\n- Estado: `Pendiente`\n- No iniciar hasta la próxima ronda.\n''')


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--apply":
        apply()
    elif mode == "--close":
        close()
    else:
        raise SystemExit("Use --apply or --close")
