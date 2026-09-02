from pathlib import Path
import re


def replace_exact(path: str, before: str, after: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(before)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s), found {count}: {before[:120]!r}")
    p.write_text(text.replace(before, after))


# PLAY regression: cd808a7 intended to allow cached playback during verification,
# but accidentally gated Play on connectionState === online. Visible cards must
# remain playable while authority is still checking. True offline still requires
# a prepared offline copy.
replace_exact(
    "src/App.tsx",
    'playbackInteractive={connectionState === "online" || Boolean(beat.offline_available)}',
    'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}',
)

# Existing-beat Web edits must not trust an installation-specific topic id copied
# from a stale manifest. Resolve through the server and persist the canonical id.
replace_exact(
    "src/features/edit/webBeatEdit.ts",
    "input: { file: File; filename: string; beatId: string; beatName: string; threadId?: number | null; kind: EditUploadKind },",
    "input: { file: File; filename: string; beatId: string; beatName: string; kind: EditUploadKind },",
)
replace_exact(
    "src/features/edit/webBeatEdit.ts",
    "  const existing = manifest.beats[existingIndex];\n  const topicCandidate = Number(existing.telegram_topic_id || 0);\n  const existingThreadId = Number.isInteger(topicCandidate) && topicCandidate > 0 ? topicCandidate : null;\n",
    "  const existing = manifest.beats[existingIndex];\n",
)
replace_exact(
    "src/features/edit/webBeatEdit.ts",
    "  const uploads = new Map<EditUploadKind, WebTransportUploadResult>();\n  let completedBytes = 0;",
    "  const uploads = new Map<EditUploadKind, WebTransportUploadResult>();\n  let resolvedThreadId: number | null = null;\n  let completedBytes = 0;",
)
replace_exact(
    "src/features/edit/webBeatEdit.ts",
    "      beatId: original.id,\n      beatName: updated.name,\n      threadId: existingThreadId,\n      kind: item.kind,",
    "      beatId: original.id,\n      beatName: updated.name,\n      kind: item.kind,",
)
replace_exact(
    "src/features/edit/webBeatEdit.ts",
    "    uploads.set(item.kind, upload);\n    completedBytes += item.file.size;",
    "    uploads.set(item.kind, upload);\n    const uploadThreadId = Number((upload as WebTransportUploadResult & { thread_id?: number }).thread_id || 0);\n    if (Number.isInteger(uploadThreadId) && uploadThreadId > 0) resolvedThreadId = uploadThreadId;\n    completedBytes += item.file.size;",
)
replace_exact(
    "src/features/edit/webBeatEdit.ts",
    "    color: updated.color,\n    color2: updated.color2,\n  };\n\n  const master",
    "    color: updated.color,\n    color2: updated.color2,\n  };\n  if (resolvedThreadId) next.telegram_topic_id = resolvedThreadId;\n\n  const master",
)

transport_path = Path("src/features/cloud/webGalerCloudTransport.ts")
transport = transport_path.read_text()
before_transport = """        upload: async (input, progress) => {
          const hintedThreadId = Number(input.threadId || 0);
          let threadId = Number.isInteger(hintedThreadId) && hintedThreadId > 0 ? hintedThreadId : 0;
          if (!threadId) {
            topic ||= ensureWebTransportTopic(input.beatId, input.beatName);
            threadId = await topic;
          }
          return this.uploadOnce({ ...input, threadId }, progress);
        },"""
after_transport = """        upload: async (input, progress) => {
          topic ||= ensureWebTransportTopic(input.beatId, input.beatName);
          const threadId = await topic;
          const uploaded = await this.uploadOnce({ ...input, threadId }, progress);
          return { ...uploaded, thread_id: threadId };
        },"""
if transport.count(before_transport) != 1:
    raise SystemExit("webGalerCloudTransport.ts: expected exact #107 hinted-thread block once")
transport_path.write_text(transport.replace(before_transport, after_transport))

# Topic ownership is vault-scoped. #106 exposed the old installation-scoped map
# because Web began calling ensure for existing-beat artwork. Search all mappings
# for the same beat in the same Telegram storage chat, prefer the oldest surviving
# topic, and alias installation mappings to that canonical topic.
server_path = Path("cloud-server/server-core.js")
server = server_path.read_text()
topic_key = """function topicKey(userId, beatId) {
  return `${String(userId)}:${String(beatId)}`;
}
"""
if server.count(topic_key) != 1:
    raise SystemExit("server-core.js: topicKey anchor not unique")
helpers = topic_key + """
function storedBeatTopicCandidates(chatId, userId, beatId) {
  const exactKey = topicKey(userId, beatId);
  const suffix = `:${String(beatId)}`;
  return [...beatTopics.entries()]
    .filter(([key, current]) => {
      const threadId = Number(current?.messageThreadId);
      return (key === exactKey || key.endsWith(suffix)) &&
        Number(current?.chatId) === Number(chatId) &&
        Number.isFinite(threadId) && threadId > 0;
    })
    .sort(([, a], [, b]) => Number(a.messageThreadId) - Number(b.messageThreadId));
}

function adoptCanonicalBeatTopic(chatId, userId, beatId, beatName, current) {
  const suffix = `:${String(beatId)}`;
  const canonical = {
    chatId: Number(chatId),
    messageThreadId: Number(current.messageThreadId),
    beatName,
    updatedAt: Date.now(),
  };
  for (const [key, candidate] of beatTopics.entries()) {
    if (key.endsWith(suffix) && Number(candidate?.chatId) === Number(chatId)) {
      beatTopics.set(key, { ...canonical });
    }
  }
  beatTopics.set(topicKey(userId, beatId), { ...canonical });
  savePersistentData();
  return canonical.messageThreadId;
}
"""
server = server.replace(topic_key, helpers)

pattern = re.compile(
    r"async function ensureBeatTopic\(account, userId, beatId, beatName\) \{.*?\n\}\n\nfunction injectTopicIds",
    re.S,
)
if len(pattern.findall(server)) != 1:
    raise SystemExit("server-core.js: ensureBeatTopic function not unique")
ensure = """async function ensureBeatTopic(account, userId, beatId, beatName) {
  if (!beatId) throw new Error("beatId is required for Telegram Topic storage.");
  const chatId = storageChatId(account);
  const key = topicKey(userId, beatId);
  const name = topicName(beatName || beatId);

  const candidates = storedBeatTopicCandidates(chatId, userId, beatId);
  for (const [candidateKey, current] of candidates) {
    const messageThreadId = Number(current.messageThreadId);
    try {
      await directTransport.editForumTopic(chatId, messageThreadId, name);
      return adoptCanonicalBeatTopic(chatId, userId, beatId, name, current);
    } catch (error) {
      if (!isMissingTopicError(error)) {
        console.warn("[topics] canonical topic verification/rename failed:", error?.message || error);
        return adoptCanonicalBeatTopic(chatId, userId, beatId, name, current);
      }
      console.warn("[topics] stored topic no longer exists; forgetting candidate:", error?.message || error);
      beatTopics.delete(candidateKey);
    }
  }

  const messageThreadId = await directTransport.createForumTopic(chatId, name);
  if (!Number.isFinite(messageThreadId) || messageThreadId <= 0) throw new Error("MASTER returned no forum topic id.");
  beatTopics.set(key, { chatId, messageThreadId, beatName: name, updatedAt: Date.now() });
  savePersistentData();
  return messageThreadId;
}

function injectTopicIds"""
server = pattern.sub(ensure, server, count=1)
server_path.write_text(server)

# Update existing source guards that intentionally pin the playback expression.
for path in ["tests/component-dom/startupRevealArchitecture.test.ts", "scripts/run-regressions.mjs"]:
    p = Path(path)
    text = p.read_text()
    text = text.replace(
        'playbackInteractive={connectionState === "online" || Boolean(beat.offline_available)}',
        'playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}',
    )
    p.write_text(text)

Path("tests/integration/issue97RuntimeWebFollowup.test.ts").write_text(r'''import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Beat } from "../../src/types";
import { commitWebBeatEdit } from "../../src/features/edit/webBeatEdit";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 production runtime follow-up", () => {
  it("replaces a stale installation topic id with the vault-resolved topic after artwork upload", async () => {
    const original = {
      id: "beat-1",
      name: "Same Beat",
      bpm: "120",
      key: "Cm",
      tags: [],
      rating: 0,
      color: "#111111",
      color2: "#222222",
      telegram_file_id: "direct:101",
      telegram_message_id: 101,
      image_base64: null,
    } as unknown as Beat;
    const updated = { ...original, image_base64: "data:image/png;base64,YQ==" };
    const uploadedInputs: Array<Record<string, unknown>> = [];
    let publishedManifest: any = null;
    const runtime = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 500,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{
            id: "beat-1",
            name: "Same Beat",
            bpm: "120",
            key: "Cm",
            tags: [],
            rating: 0,
            color: "#111111",
            color2: "#222222",
            telegram_topic_id: 4242,
            master: { telegram_message_id: 101, filename: "old.mp3", mime: "audio/mpeg", size: 10 },
          }],
          trash: [],
        },
      })),
      upload: vi.fn(async (input: Record<string, unknown>) => {
        uploadedInputs.push(input);
        return {
          telegram_file_id: "file-new",
          telegram_message_id: 202,
          filename: "cover.png",
          original_size: 1,
          parts: [],
          transport: "direct-web" as const,
          thread_id: 3131,
        };
      }),
      replaceLibraryIndex: vi.fn(async (input: { manifest: unknown }) => {
        publishedManifest = input.manifest;
        return { messageId: 501, beatCount: 1, updated: true };
      }),
    };

    await commitWebBeatEdit(original, updated, {}, runtime);
    expect(uploadedInputs).toHaveLength(1);
    expect(uploadedInputs[0]).not.toHaveProperty("threadId");
    expect(publishedManifest.beats[0].telegram_topic_id).toBe(3131);
  });

  it("keeps visible cloud cards playable while authority is still checking", () => {
    const app = source("src/App.tsx");
    const card = source("src/components/BeatCard.tsx");
    expect(app).toContain('playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}');
    expect(card).toContain("if (!playbackInteractive || playbackBlocked) return;");
  });

  it("resolves an existing beat topic by vault rather than installation", () => {
    const server = source("cloud-server/server-core.js");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    expect(server).toContain("function storedBeatTopicCandidates(chatId, userId, beatId)");
    expect(server).toContain("key.endsWith(suffix)");
    expect(server).toContain("Number(current?.chatId) === Number(chatId)");
    expect(server).toContain("Number(a.messageThreadId) - Number(b.messageThreadId)");
    expect(server).toContain("adoptCanonicalBeatTopic(chatId, userId, beatId, name, current)");
    expect(transport).not.toContain("hintedThreadId");
    expect(transport).toContain("return { ...uploaded, thread_id: threadId };");
  });

  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/App.tsx");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(app).toContain("onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(app).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });

  it("does not let Web card warming queue native cooking ahead of Play", () => {
    const app = source("src/App.tsx");
    expect(app).toContain("if (!platform.capabilities.playbackCache) return;");
    expect(app).toContain("Math.min(isTauriAvailable ? 6 : 1, queue.length)");
  });
});
''')

print("ISSUE97_REGRESSION_ROOT_PATCH_OK")
