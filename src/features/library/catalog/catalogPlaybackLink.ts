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
