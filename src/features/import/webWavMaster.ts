export async function createWebWavMaster(wav: File, signal?: AbortSignal): Promise<File> {
  const { encodeWebWavMaster } = await import("./encodeWebWavMaster");
  return encodeWebWavMaster(wav, signal);
}
