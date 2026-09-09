const busyBeatIds = new Set<string>();

export function isBeatCloudUpdateBusy(beatId: string): boolean {
  return busyBeatIds.has(beatId);
}

export function setBeatCloudUpdateBusy(beatId: string, active: boolean, success = false): void {
  if (active) busyBeatIds.add(beatId);
  else busyBeatIds.delete(beatId);
  window.dispatchEvent(new CustomEvent("beatgaler:beat-cloud-busy", {
    detail: { beatId, active, success },
  }));
}
