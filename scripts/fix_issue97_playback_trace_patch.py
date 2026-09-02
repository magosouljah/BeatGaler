from pathlib import Path

path = Path("scripts/issue97_playback_trace_patch.py")
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)

marker = next((i for i, line in enumerate(lines) if "WORKER_STREAM_MESSAGE_READY" in line), None)
if marker is None:
    raise SystemExit("playback trace patch: WORKER_STREAM_MESSAGE_READY block not found")

start = marker
while start >= 0 and lines[start].strip() != "replace_exact(":
    start -= 1
if start < 0:
    raise SystemExit("playback trace patch: replacement block start not found")

end = marker
while end < len(lines) and lines[end].strip() != ")":
    end += 1
if end >= len(lines):
    raise SystemExit("playback trace patch: replacement block end not found")
end += 1

replacement = r'''worker_path = Path("src/features/cloud/webTransport.worker.ts")
worker_text = worker_path.read_text(encoding="utf-8")
stream_start_anchor = 'async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {'
stream_start = worker_text.find(stream_start_anchor)
if stream_start < 0:
    raise SystemExit("webTransport.worker.ts: stream() anchor not found")
message_anchor = '  const [message] = await active.getMessages(chatId, [messageId]);\n  if (!message) throw new Error("Galer Cloud object no longer exists.");'
message_pos = worker_text.find(message_anchor, stream_start)
if message_pos < 0:
    raise SystemExit("webTransport.worker.ts: stream message anchor not found")
message_after = '  const [message] = await active.getMessages(chatId, [messageId]);\n  playTrace("WORKER_STREAM_MESSAGE_READY", { elapsed_ms: Date.now() - started });\n  if (!message) throw new Error("Galer Cloud object no longer exists.");'
worker_text = worker_text[:message_pos] + message_after + worker_text[message_pos + len(message_anchor):]
worker_path.write_text(worker_text, encoding="utf-8")
'''.splitlines(keepends=True)

lines[start:end] = replacement
path.write_text("".join(lines), encoding="utf-8")
print("ISSUE97_TRACE_PATCH_ANCHOR_FIXED")
