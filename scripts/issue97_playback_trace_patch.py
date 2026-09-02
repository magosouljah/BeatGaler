from pathlib import Path


def replace_exact(path: str, before: str, after: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(before)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s), found {count}: {before[:160]!r}")
    p.write_text(text.replace(before, after), encoding="utf-8")


# App: prove whether the card click reaches handlePlay and where preparePlayback waits.
replace_exact(
    "src/App.tsx",
    'import { isBeatPlaybackBlocked } from "./features/playback/playbackReadiness";',
    'import { isBeatPlaybackBlocked } from "./features/playback/playbackReadiness";\nimport { playTrace } from "./features/playback/playTrace";',
)
replace_exact(
    "src/App.tsx",
    '    const latestBeat = beatsLatestRef.current.find(item => item.id === beat.id) ?? beat;\n    if (beatCloudUpdateBusyIds.has(beat.id) || isBeatPlaybackBlocked(beat) || isBeatPlaybackBlocked(latestBeat)) {',
    '    const latestBeat = beatsLatestRef.current.find(item => item.id === beat.id) ?? beat;\n    playTrace("APP_HANDLE_PLAY_ENTER", {\n      beat_id: beat.id,\n      render_status: beat.cloud_status || null,\n      latest_status: latestBeat.cloud_status || null,\n      slot_busy: beatCloudUpdateBusyIds.has(beat.id),\n    });\n    if (beatCloudUpdateBusyIds.has(beat.id) || isBeatPlaybackBlocked(beat) || isBeatPlaybackBlocked(latestBeat)) {',
)
replace_exact(
    "src/App.tsx",
    '      const reason = beatCloudUpdateBusyIds.has(beat.id) ? "SLOT_UPDATE" : String(blocked.cloud_status || "");\n      void downloadCookingDiagnosticEvent("PLAY_BLOCKED_LOADING", blocked.id, blocked.name, reason).catch(() => {});\n      return;',
    '      const reason = beatCloudUpdateBusyIds.has(beat.id) ? "SLOT_UPDATE" : String(blocked.cloud_status || "");\n      playTrace("APP_HANDLE_PLAY_BLOCKED", { beat_id: blocked.id, reason });\n      void downloadCookingDiagnosticEvent("PLAY_BLOCKED_LOADING", blocked.id, blocked.name, reason).catch(() => {});\n      return;',
)
replace_exact(
    "src/App.tsx",
    '        const prepared = await platform.media.preparePlayback(beat);',
    '        playTrace("APP_PREPARE_BEGIN", { beat_id: beat.id });\n        const prepared = await platform.media.preparePlayback(beat);\n        playTrace("APP_PREPARE_READY", { beat_id: beat.id, url_scheme: String(prepared.url || "").split(":")[0] || null });',
)
replace_exact(
    "src/App.tsx",
    '        play(beat.id, [prepared.url]);',
    '        playTrace("APP_AUDIO_PLAY_CALL", { beat_id: beat.id });\n        play(beat.id, [prepared.url]);',
)
replace_exact(
    "src/App.tsx",
    '      } catch (error) {\n        platform.media.releasePlayback(beat.id);',
    '      } catch (error) {\n        playTrace("APP_PREPARE_ERROR", { beat_id: beat.id, error_name: error instanceof Error ? error.name : "unknown" });\n        platform.media.releasePlayback(beat.id);',
)

# BeatCard: prove click acceptance independently of App/transport.
replace_exact(
    "src/components/BeatCard.tsx",
    'import { beatCardIncompleteReasons, beatCardPlaybackBlocked, shouldShowIncompleteWarning, sortBeatCardTags } from "../features/components/componentLogic";',
    'import { beatCardIncompleteReasons, beatCardPlaybackBlocked, shouldShowIncompleteWarning, sortBeatCardTags } from "../features/components/componentLogic";\nimport { playTrace } from "../features/playback/playTrace";',
)
replace_exact(
    "src/components/BeatCard.tsx",
    '          e.stopPropagation();\n          if (!playbackInteractive || playbackBlocked) return;\n          onPlay(beat);',
    '          e.stopPropagation();\n          playTrace("CARD_PLAY_CLICK", {\n            beat_id: beat.id,\n            playback_interactive: playbackInteractive,\n            playback_blocked: playbackBlocked,\n            interactive,\n            cloud_status: beat.cloud_status || null,\n          });\n          if (!playbackInteractive || playbackBlocked) {\n            playTrace("CARD_PLAY_REJECTED", { beat_id: beat.id });\n            return;\n          }\n          playTrace("CARD_PLAY_ACCEPTED", { beat_id: beat.id });\n          onPlay(beat);',
)

# Web adapter: identify entry/exit around the playback source manager.
replace_exact(
    "src/platform/webAdapter.ts",
    'import { WebPlaybackSourceManager } from "../features/playback/webPlaybackSource";',
    'import { WebPlaybackSourceManager } from "../features/playback/webPlaybackSource";\nimport { playTrace } from "../features/playback/playTrace";',
)
replace_exact(
    "src/platform/webAdapter.ts",
    '      if (messageId) {\n        const sources = await resolveWebPlaybackSources();\n        return sources.prepare(beat.id, messageId, master?.mime_type || "audio/mpeg");\n      }',
    '      if (messageId) {\n        playTrace("ADAPTER_PREPARE_ENTER", { beat_id: beat.id, mime_type: master?.mime_type || "audio/mpeg" });\n        const sources = await resolveWebPlaybackSources();\n        playTrace("ADAPTER_SOURCE_MANAGER_READY", { beat_id: beat.id });\n        const prepared = await sources.prepare(beat.id, messageId, master?.mime_type || "audio/mpeg");\n        playTrace("ADAPTER_PREPARE_READY", { beat_id: beat.id });\n        return prepared;\n      }',
)
replace_exact(
    "src/platform/webAdapter.ts",
    '      if (beat.playback_path.startsWith("blob:")) {\n        return { url: beat.playback_path, completed: Promise.resolve() };\n      }',
    '      if (beat.playback_path.startsWith("blob:")) {\n        playTrace("ADAPTER_LOCAL_BLOB", { beat_id: beat.id });\n        return { url: beat.playback_path, completed: Promise.resolve() };\n      }',
)

# Source manager: distinguish MSE from full-file Blob fallback and first-chunk timing.
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    'import type { WebTransportStreamInput, WebTransportStreamResult } from "../cloud/webTransportWorkerProtocol";',
    'import type { WebTransportStreamInput, WebTransportStreamResult } from "../cloud/webTransportWorkerProtocol";\nimport { playTrace } from "./playTrace";',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '  prepare(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<PreparedWebPlayback> {\n    const existing = this.entries.get(beatId);',
    '  prepare(beatId: string, messageId: number, mimeType = "audio/mpeg"): Promise<PreparedWebPlayback> {\n    const mediaSourceSupported = supportsMediaSource(mimeType);\n    playTrace("SOURCE_PREPARE", { beat_id: beatId, mime_type: mimeType, mode: mediaSourceSupported ? "mse" : "blob" });\n    const existing = this.entries.get(beatId);',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '    const preparation = (supportsMediaSource(mimeType)\n      ? this.prepareMediaSource(beatId, messageId, mimeType)\n      : this.prepareBlobFallback(beatId, messageId, mimeType)',
    '    const preparation = (mediaSourceSupported\n      ? this.prepareMediaSource(beatId, messageId, mimeType)\n      : this.prepareBlobFallback(beatId, messageId, mimeType)',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '  private async prepareMediaSource(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {\n    const mediaSource = new MediaSource();',
    '  private async prepareMediaSource(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {\n    playTrace("SOURCE_MSE_BEGIN", { beat_id: beatId });\n    const mediaSource = new MediaSource();',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '    mediaSource.addEventListener("sourceopen", () => {\n      if (entry.released || entry.sourceBuffer) return;',
    '    mediaSource.addEventListener("sourceopen", () => {\n      playTrace("SOURCE_MSE_SOURCEOPEN", { beat_id: beatId });\n      if (entry.released || entry.sourceBuffer) return;',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '    try {\n      const stream = await this.transport.streamFile({ messageId, mimeType }, chunk => {\n        if (entry.released) return Promise.reject(abortError());',
    '    try {\n      let firstChunkLogged = false;\n      playTrace("SOURCE_STREAM_REQUEST", { beat_id: beatId });\n      const stream = await this.transport.streamFile({ messageId, mimeType }, chunk => {\n        if (!firstChunkLogged) {\n          firstChunkLogged = true;\n          playTrace("SOURCE_FIRST_CHUNK", { beat_id: beatId, bytes: chunk.byteLength });\n        }\n        if (entry.released) return Promise.reject(abortError());',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '      entry.cancel = stream.cancel;\n      if (entry.released) {',
    '      playTrace("SOURCE_STREAM_HANDLE_READY", { beat_id: beatId });\n      entry.cancel = stream.cancel;\n      if (entry.released) {',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '      return { url, completed };',
    '      playTrace("SOURCE_URL_READY", { beat_id: beatId, mode: "mse" });\n      return { url, completed };',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '  private async prepareBlobFallback(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {\n    const chunks: ArrayBuffer[] = [];\n    let placeholder: PlaybackEntry | null = null;\n    const stream = await this.transport.streamFile({ messageId, mimeType }, chunk => {\n      if (!placeholder?.released) chunks.push(chunk);\n    });',
    '  private async prepareBlobFallback(beatId: string, messageId: number, mimeType: string): Promise<PreparedWebPlayback> {\n    playTrace("SOURCE_BLOB_BEGIN", { beat_id: beatId });\n    const chunks: ArrayBuffer[] = [];\n    let firstChunkLogged = false;\n    let placeholder: PlaybackEntry | null = null;\n    const stream = await this.transport.streamFile({ messageId, mimeType }, chunk => {\n      if (!firstChunkLogged) {\n        firstChunkLogged = true;\n        playTrace("SOURCE_FIRST_CHUNK", { beat_id: beatId, bytes: chunk.byteLength });\n      }\n      if (!placeholder?.released) chunks.push(chunk);\n    });\n    playTrace("SOURCE_STREAM_HANDLE_READY", { beat_id: beatId });',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '      const result = await stream.completed;\n      if (placeholder.released) throw abortError();',
    '      const result = await stream.completed;\n      playTrace("SOURCE_BLOB_DOWNLOAD_DONE", { beat_id: beatId, chunks: chunks.length });\n      if (placeholder.released) throw abortError();',
)
replace_exact(
    "src/features/playback/webPlaybackSource.ts",
    '      placeholder.streamDone = true;\n      return { url, completed: Promise.resolve() };',
    '      placeholder.streamDone = true;\n      playTrace("SOURCE_URL_READY", { beat_id: beatId, mode: "blob" });\n      return { url, completed: Promise.resolve() };',
)

# Transport: split connection wait, operation admission wait and Worker startup.
replace_exact(
    "src/features/cloud/webGalerCloudTransport.ts",
    'import type { PlatformTrashItem } from "../../platform/contracts";',
    'import type { PlatformTrashItem } from "../../platform/contracts";\nimport { playTrace } from "../playback/playTrace";',
)
replace_exact(
    "src/features/cloud/webGalerCloudTransport.ts",
    '''  async getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {\n    await this.controller.connect();\n    return this.controller.withOperation(\n      "get_index",\n      { objectType: "index", objectIds: ["pinned"] },\n      () => this.worker.getLibraryIndex(),\n    );\n  }''',
    '''  async getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {\n    const started = Date.now();\n    playTrace("TRANSPORT_GET_INDEX_ENTER");\n    const connectStarted = Date.now();\n    await this.controller.connect();\n    playTrace("TRANSPORT_GET_INDEX_CONNECTED", { wait_ms: Date.now() - connectStarted });\n    const operationStarted = Date.now();\n    const result = await this.controller.withOperation(\n      "get_index",\n      { objectType: "index", objectIds: ["pinned"] },\n      () => this.worker.getLibraryIndex(),\n    );\n    playTrace("TRANSPORT_GET_INDEX_DONE", { operation_ms: Date.now() - operationStarted, total_ms: Date.now() - started });\n    return result;\n  }''',
)
replace_exact(
    "src/features/cloud/webGalerCloudTransport.ts",
    '''  async streamFile(\n    input: WebTransportStreamInput,\n    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,\n  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }> {\n    await this.controller.connect();\n    const lease = await this.controller.beginOperation(\n      "stream_master",\n      { objectType: "message", objectIds: [String(input.messageId)] },\n    );\n    const stream = this.worker.stream(input, onChunk);\n    return {\n      completed: stream.completed.finally(() => this.controller.endOperation(lease).catch(() => {})),\n      cancel: stream.cancel,\n    };\n  }''',
    '''  async streamFile(\n    input: WebTransportStreamInput,\n    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,\n  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }> {\n    const started = Date.now();\n    playTrace("TRANSPORT_STREAM_ENTER");\n    const connectStarted = Date.now();\n    await this.controller.connect();\n    playTrace("TRANSPORT_STREAM_CONNECTED", { wait_ms: Date.now() - connectStarted });\n    const operationStarted = Date.now();\n    const lease = await this.controller.beginOperation(\n      "stream_master",\n      { objectType: "message", objectIds: [String(input.messageId)] },\n    );\n    playTrace("TRANSPORT_STREAM_ADMITTED", { wait_ms: Date.now() - operationStarted });\n    const stream = this.worker.stream(input, onChunk);\n    playTrace("TRANSPORT_STREAM_WORKER_STARTED", { total_ms: Date.now() - started });\n    return {\n      completed: stream.completed.finally(() => {\n        playTrace("TRANSPORT_STREAM_DONE", { total_ms: Date.now() - started });\n        return this.controller.endOperation(lease).catch(() => {});\n      }),\n      cancel: stream.cancel,\n    };\n  }''',
)

# Controller: reveal whether Play joins the initial connection bootstrap and which stage is slow.
replace_exact(
    "src/features/cloud/webTransportController.ts",
    '} from "./webTransportSession";',
    '} from "./webTransportSession";\nimport { playTrace } from "../playback/playTrace";',
)
replace_exact(
    "src/features/cloud/webTransportController.ts",
    '''  async connect(): Promise<WebTransportSession> {\n    if (this.closed) throw new Error("Galer Cloud Web transport is closed.");\n    if (this.session) return this.session;\n    if (this.connectPromise) return this.connectPromise;\n    this.connectPromise = this.openSession().finally(() => { this.connectPromise = null; });\n    return this.connectPromise;\n  }''',
    '''  async connect(): Promise<WebTransportSession> {\n    if (this.closed) throw new Error("Galer Cloud Web transport is closed.");\n    if (this.session) {\n      playTrace("CONTROLLER_CONNECT_REUSE");\n      return this.session;\n    }\n    if (this.connectPromise) {\n      playTrace("CONTROLLER_CONNECT_JOIN");\n      return this.connectPromise;\n    }\n    playTrace("CONTROLLER_CONNECT_NEW");\n    this.connectPromise = this.openSession().finally(() => { this.connectPromise = null; });\n    return this.connectPromise;\n  }''',
)
replace_exact(
    "src/features/cloud/webTransportController.ts",
    '''  private async openSession(): Promise<WebTransportSession> {\n    const session = await this.api.prepare();\n    try {\n      await this.runtime.initialize(session);\n      await this.api.activate(session);\n      await this.runtime.verifyReady(session);\n      this.session = session;''',
    '''  private async openSession(): Promise<WebTransportSession> {\n    const started = Date.now();\n    playTrace("CONTROLLER_SESSION_PREPARE_BEGIN");\n    const session = await this.api.prepare();\n    playTrace("CONTROLLER_SESSION_PREPARE_DONE", { elapsed_ms: Date.now() - started });\n    try {\n      const initializeStarted = Date.now();\n      await this.runtime.initialize(session);\n      playTrace("CONTROLLER_SESSION_INITIALIZE_DONE", { elapsed_ms: Date.now() - initializeStarted });\n      const activateStarted = Date.now();\n      await this.api.activate(session);\n      playTrace("CONTROLLER_SESSION_ACTIVATE_DONE", { elapsed_ms: Date.now() - activateStarted });\n      const verifyStarted = Date.now();\n      await this.runtime.verifyReady(session);\n      playTrace("CONTROLLER_SESSION_VERIFY_DONE", { elapsed_ms: Date.now() - verifyStarted });\n      this.session = session;\n      playTrace("CONTROLLER_SESSION_READY", { total_ms: Date.now() - started });''',
)
replace_exact(
    "src/features/cloud/webTransportController.ts",
    '      if (response.waitMs !== null) {\n        await wait(response.waitMs);\n        continue;\n      }',
    '      if (response.waitMs !== null) {\n        playTrace("CONTROLLER_OPERATION_WAIT", { kind, wait_ms: response.waitMs });\n        await wait(response.waitMs);\n        continue;\n      }',
)

# Worker: correlate session bootstrap, INDEX read and MASTER stream on the data plane itself.
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    'import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";',
    'import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";\nimport { playTrace } from "../playback/playTrace";',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    'async function initialize(command: Extract<WebTransportWorkerCommand, { op: "initialize" }>): Promise<void> {\n  await closeClient();',
    'async function initialize(command: Extract<WebTransportWorkerCommand, { op: "initialize" }>): Promise<void> {\n  const started = Date.now();\n  playTrace("WORKER_INITIALIZE_BEGIN");\n  await closeClient();',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '  client = next;\n  chatId = numericChatId;\n}',
    '  client = next;\n  chatId = numericChatId;\n  playTrace("WORKER_INITIALIZE_DONE", { elapsed_ms: Date.now() - started });\n}',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    'async function verifyReady(): Promise<void> {\n  if (!client || !chatId) throw new Error("Galer Cloud Web transport is not initialized.");\n  await client.getChat(chatId);\n  vaultVerified = true;\n}',
    'async function verifyReady(): Promise<void> {\n  if (!client || !chatId) throw new Error("Galer Cloud Web transport is not initialized.");\n  const started = Date.now();\n  playTrace("WORKER_VERIFY_BEGIN");\n  await client.getChat(chatId);\n  vaultVerified = true;\n  playTrace("WORKER_VERIFY_DONE", { elapsed_ms: Date.now() - started });\n}',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    'async function getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {\n  const active = requireReady();\n  let lastError: unknown = null;',
    'async function getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {\n  const started = Date.now();\n  playTrace("WORKER_GET_INDEX_BEGIN");\n  const active = requireReady();\n  let lastError: unknown = null;',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '      const fullChat = await active.getFullChat(chatId);\n      const pinnedId = Number(fullChat.pinnedMsgId || 0);',
    '      const fullChat = await active.getFullChat(chatId);\n      playTrace("WORKER_GET_INDEX_FULL_CHAT", { attempt: attempt + 1 });\n      const pinnedId = Number(fullChat.pinnedMsgId || 0);',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '      const [message] = await active.getMessages(chatId, [pinnedId]);\n      if (!message || !message.text.startsWith(LIBRARY_INDEX_CAPTION)) {',
    '      const [message] = await active.getMessages(chatId, [pinnedId]);\n      playTrace("WORKER_GET_INDEX_MESSAGE", { attempt: attempt + 1 });\n      if (!message || !message.text.startsWith(LIBRARY_INDEX_CAPTION)) {',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '      const bytes = await active.downloadAsBuffer(downloadableMedia(message), { stallTimeout: 20_000 });\n      if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) {',
    '      const bytes = await active.downloadAsBuffer(downloadableMedia(message), { stallTimeout: 20_000 });\n      playTrace("WORKER_GET_INDEX_BYTES", { attempt: attempt + 1, bytes: bytes.byteLength });\n      if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) {',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '      return { manifest: JSON.parse(new TextDecoder().decode(bytes)), messageId: pinnedId };\n    } catch (error) {\n      lastError = error;',
    '      playTrace("WORKER_GET_INDEX_DONE", { attempt: attempt + 1, elapsed_ms: Date.now() - started });\n      return { manifest: JSON.parse(new TextDecoder().decode(bytes)), messageId: pinnedId };\n    } catch (error) {\n      playTrace("WORKER_GET_INDEX_RETRY", { attempt: attempt + 1, error_name: error instanceof Error ? error.name : "unknown" });\n      lastError = error;',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    'async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {\n  const active = requireReady();',
    'async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {\n  const started = Date.now();\n  playTrace("WORKER_STREAM_BEGIN");\n  const active = requireReady();',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '  const [message] = await active.getMessages(chatId, [messageId]);\n  if (!message) throw new Error("Galer Cloud object no longer exists.");',
    '  const [message] = await active.getMessages(chatId, [messageId]);\n  playTrace("WORKER_STREAM_MESSAGE_READY", { elapsed_ms: Date.now() - started });\n  if (!message) throw new Error("Galer Cloud object no longer exists.");',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '  let downloadedBytes = 0;\n  try {\n    for await (const chunk of active.downloadAsIterable(media, { abortSignal: controller.signal, stallTimeout: 20_000, partSize: 256 })) {\n      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");\n      downloadedBytes += chunk.byteLength;',
    '  let downloadedBytes = 0;\n  let firstChunkLogged = false;\n  try {\n    for await (const chunk of active.downloadAsIterable(media, { abortSignal: controller.signal, stallTimeout: 20_000, partSize: 256 })) {\n      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");\n      downloadedBytes += chunk.byteLength;\n      if (!firstChunkLogged) {\n        firstChunkLogged = true;\n        playTrace("WORKER_STREAM_FIRST_CHUNK", { elapsed_ms: Date.now() - started, bytes: chunk.byteLength });\n      }',
)
replace_exact(
    "src/features/cloud/webTransport.worker.ts",
    '    if (downloadedBytes <= 0) throw new Error("Galer Cloud returned an empty object.");\n    return { messageId, totalBytes: totalBytes || downloadedBytes, mimeType };',
    '    if (downloadedBytes <= 0) throw new Error("Galer Cloud returned an empty object.");\n    playTrace("WORKER_STREAM_DONE", { elapsed_ms: Date.now() - started, bytes: downloadedBytes });\n    return { messageId, totalBytes: totalBytes || downloadedBytes, mimeType };',
)

# HTMLAudioElement: prove URL attachment, canplay/playing and autoplay rejection.
replace_exact(
    "src/hooks/useAudio.ts",
    'import { platform } from "../platform";',
    'import { platform } from "../platform";\nimport { playTrace } from "../features/playback/playTrace";',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '    const onPlay = () => setState((s) => ({ ...s, isPlaying: true }));',
    '    const onPlay = () => {\n      playTrace("AUDIO_EVENT_PLAY", { beat_id: currentBeatIdRef.current, ready_state: audio.readyState });\n      setState((s) => ({ ...s, isPlaying: true }));\n    };',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '    const onPlaying = () => {\n      const beatId = currentBeatIdRef.current;',
    '    const onPlaying = () => {\n      const beatId = currentBeatIdRef.current;\n      playTrace("AUDIO_EVENT_PLAYING", { beat_id: beatId, ready_state: audio.readyState, current_time: audio.currentTime });',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '    const onWaiting = () => {\n      void platform.diagnostics.audioEvent',
    '    const onWaiting = () => {\n      playTrace("AUDIO_EVENT_WAITING", { beat_id: currentBeatIdRef.current, ready_state: audio.readyState, current_time: audio.currentTime });\n      void platform.diagnostics.audioEvent',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '    const onCanPlay = () => {\n      void platform.diagnostics.audioEvent',
    '    const onCanPlay = () => {\n      playTrace("AUDIO_EVENT_CANPLAY", { beat_id: currentBeatIdRef.current, ready_state: audio.readyState });\n      void platform.diagnostics.audioEvent',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '    const onError = () => {\n      if (primingRef.current) return;',
    '    const onError = () => {\n      playTrace("AUDIO_EVENT_ERROR", { beat_id: currentBeatIdRef.current, media_error: audio.error?.code || null, priming: primingRef.current });\n      if (primingRef.current) return;',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '  const play = useCallback((beatId: string, paths: string[]) => {\n    const audio = getAudio();',
    '  const play = useCallback((beatId: string, paths: string[]) => {\n    const audio = getAudio();\n    playTrace("AUDIO_PLAY_FUNCTION_ENTER", { beat_id: beatId, ready_state: audio.readyState, paused: audio.paused });',
)
replace_exact(
    "src/hooks/useAudio.ts",
    '    void platform.diagnostics.audioEvent("AUDIO_SRC_SET", beatId, null, sources[0]).catch(() => {});\n    setState((s) => ({ ...s, playingId: beatId, progress: 0, duration: 0 }));\n    audio.play().catch(console.error);',
    '    void platform.diagnostics.audioEvent("AUDIO_SRC_SET", beatId, null, sources[0]).catch(() => {});\n    playTrace("AUDIO_SRC_SET", { beat_id: beatId, ready_state: audio.readyState, url_scheme: String(sources[0] || "").split(":")[0] || null });\n    setState((s) => ({ ...s, playingId: beatId, progress: 0, duration: 0 }));\n    playTrace("AUDIO_PLAY_PROMISE_BEGIN", { beat_id: beatId });\n    audio.play().then(\n      () => playTrace("AUDIO_PLAY_PROMISE_RESOLVED", { beat_id: beatId }),\n      error => {\n        playTrace("AUDIO_PLAY_PROMISE_REJECTED", { beat_id: beatId, error_name: error instanceof Error ? error.name : "unknown" });\n        console.error(error);\n      },\n    );',
)

print("ISSUE97_PLAYBACK_TRACE_PATCH_OK")
