import type { Beat } from "../../../types";
import type { CatalogBeatDto } from "./catalogApi";
import type { AudioState } from "../../../hooks/useAudio";
import type { CatalogPlaybackSession } from "./catalogPlaybackSession";

interface EngineFacade {
  state: Pick<AudioState, "endedSeq" | "progress">;
  play(beatId: string, urls: string[]): void;
  seek(ratio: number): void;
  togglePause(): void;
}

export function linkPlayback(
  session: CatalogPlaybackSession,
  engine: () => EngineFacade,
  dom: { audioPaused(): boolean | null },
) {
  let lastEnded = engine().state.endedSeq;
  let lastObservedProgress: number | undefined;
  let lastPublishedProgress = 0;

  function subscribe() {
    return session.onEvent(({ kind, beatId }) => {
      const { source } = session.getSnapshot();
      const audio = engine();
      if (kind === "play" && beatId && source) audio.play(beatId, [source.url]);
      else if (kind === "seek0") audio.seek(0);
      else if (kind === "replay") {
        audio.seek(0);
        if (dom.audioPaused() === true) audio.togglePause();
      }
    });
  }

  let unsubscribe = subscribe();
  return {
    setSession(next: CatalogPlaybackSession) {
      if (next === session) return;
      unsubscribe();
      session = next;
      unsubscribe = subscribe();
      // La sustitución de servicios vuelve a evaluar el progreso sin reiniciar las señales del motor.
      lastObservedProgress = undefined;
    },
    onEngineState({ endedSeq, progress }: EngineFacade["state"], onEndedFailure: (error: unknown) => void) {
      if (endedSeq !== lastEnded) {
        lastEnded = endedSeq;
        void session.ended().catch(onEndedFailure);
      }
      if (Object.is(progress, lastObservedProgress)) return;
      lastObservedProgress = progress;
      if (Math.abs(progress - lastPublishedProgress) >= 0.01 || progress === 0) {
        lastPublishedProgress = progress;
        session.setProgress(progress);
      }
    },
    dispose() {
      unsubscribe();
    },
  };
}


export function reportPlaybackFailure(setNotice: (text: string) => void, action: string, error: unknown): void {
  const { code, message } = (error as { code?: unknown; message?: unknown }) ?? {};
  setNotice(`${action}: ${code ? `${String(code)} — ` : ""}${String(message ?? error)}`);
}

export function createGalleryPlaybackCommands({ session, knownDto, playingId, togglePause, setNotice }: {
  session: CatalogPlaybackSession;
  knownDto(id: string): CatalogBeatDto | undefined;
  playingId: string | null;
  togglePause(): void;
  setNotice(text: string): void;
}) {
  function targetOf({ id }: Beat) {
    const dto = knownDto(id);
    return { beatId: id, version: dto?.version ?? null, fileId: dto?.playback?.fileId ?? null };
  }
  const onFailure = (action: string) => (error: unknown) => reportPlaybackFailure(setNotice, action, error);
  const onPlayFailure = onFailure("No se pudo reproducir el beat");

  return {
    handlePlay(beat: Beat) {
      if (playingId === beat.id) { togglePause(); return; }
      void session.play(targetOf(beat)).catch(onPlayFailure);
    },
    addToQueue(beat: Beat) { session.enqueue(targetOf(beat)); },
    handleNext() { void session.next().catch(onFailure("No se pudo pasar al siguiente beat")); },
    handlePrev() { void session.previous().catch(onFailure("No se pudo volver al beat anterior")); },
    toggleShuffle() { void session.setShuffle(!session.getSnapshot().shuffle); },
    cycleRepeat() {
      const { repeat } = session.getSnapshot();
      session.setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
    },
    playQueueIndex(index: number) {
      const target = session.getSnapshot().queue[index];
      if (!target) return;
      session.dequeue(target.beatId);
      void session.play(target).catch(onPlayFailure);
    },
  };
}
