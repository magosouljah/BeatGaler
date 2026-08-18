const fs = require("fs");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "master-session.txt");

function readSession() {
  const envSession = String(process.env.BEATGALER_MASTER_SESSION || "").trim();
  if (envSession) return envSession;
  if (!fs.existsSync(SESSION_FILE)) return "";
  return fs.readFileSync(SESSION_FILE, "utf8").trim();
}

function masterStorageReady() {
  return Boolean(
    readSession() &&
    process.env.TELEGRAM_API_ID &&
    process.env.TELEGRAM_API_HASH
  );
}

function channelIdToBotApiChatId(channelId) {
  const raw = BigInt(String(channelId));
  const asText = `-100${raw.toString()}`;
  const asNumber = Number(asText);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Telegram chat id ${asText} is outside JavaScript safe integer range.`);
  }
  return asNumber;
}

async function openMasterClient() {
  let TelegramClient, StringSession, Api;
  try {
    ({ TelegramClient, Api } = require("telegram"));
    ({ StringSession } = require("telegram/sessions"));
  } catch {
    throw new Error('Missing GramJS. Run "cd cloud-server" then "npm install".');
  }

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "");
  const session = readSession();
  if (!Number.isFinite(apiId) || !apiHash || !session) {
    throw new Error("Master Telegram account is not configured. Run node setup-master-account.js.");
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    useWSS: false,
  });
  try { client.setLogLevel?.("none"); } catch (_) {}
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error("Saved master Telegram session is no longer authorized.");
  }
  return { client, Api };
}

async function createPrivateUserStorageGroup({ username }) {
  const { client, Api } = await openMasterClient();
  try {
    const title = String(username || "user").trim();
    const created = await client.invoke(new Api.channels.CreateChannel({
      title,
      about: "Private BeatGaler storage. Managed automatically. End users are not members.",
      megagroup: true,
      forum: true,
    }));

    const channel = (created.chats || []).find(chat => chat && chat.id);
    if (!channel) throw new Error("Telegram created the group but returned no channel entity.");

    try {
      await client.invoke(new Api.channels.EditForumTopic({
        channel,
        topicId: 1,
        title: "#general",
      }));
    } catch (error) {
      const message = String(error?.errorMessage || error?.message || error);
      if (!/TOPIC_NOT_MODIFIED/i.test(message)) throw error;
    }
    await client.invoke(new Api.channels.UpdatePinnedForumTopic({
      channel,
      topicId: 1,
      pinned: true,
    }));

    // Deliberately DO NOT add the manager/service bot here. MASTER owns the
    // vault. A single transport bot is added only while a BeatGaler session is
    // active and is removed again when that session ends.
    return {
      title,
      channelId: String(channel.id),
      botApiChatId: channelIdToBotApiChatId(channel.id),
    };
  } finally {
    await client.disconnect();
  }
}

async function findStorageChannelByBotApiId(client, botApiChatId) {
  const text = String(botApiChatId || "").trim();
  if (!/^-100\d+$/.test(text)) throw new Error("Invalid stored Telegram storage chat id.");
  const channelId = text.slice(4);
  const dialogs = await client.getDialogs({ limit: 1000 });
  const dialog = dialogs.find(item => String(item?.entity?.id || "") === channelId);
  if (!dialog?.entity) throw new Error("The private storage group could not be found by MASTER.");
  return dialog.entity;
}

async function ensurePrivateUserStorageBotAbsent({ botApiChatId, botUsername }) {
  const username = String(botUsername || "").replace(/^@/, "").trim();
  if (!username) return false;
  const { client, Api } = await openMasterClient();
  try {
    const channel = await findStorageChannelByBotApiId(client, botApiChatId);
    const botPeer = await client.getInputEntity(username);
    try {
      await client.invoke(new Api.channels.EditBanned({
        channel,
        participant: botPeer,
        bannedRights: new Api.ChatBannedRights({
          untilDate: 0,
          viewMessages: true,
          sendMessages: true,
          sendMedia: true,
          sendStickers: true,
          sendGifs: true,
          sendGames: true,
          sendInline: true,
          embedLinks: true,
          sendPolls: true,
          changeInfo: true,
          inviteUsers: true,
          pinMessages: true,
          manageTopics: true,
          sendPhotos: true,
          sendVideos: true,
          sendRoundvideos: true,
          sendAudios: true,
          sendVoices: true,
          sendDocs: true,
          sendPlain: true,
        }),
      }));
    } catch (error) {
      const message = String(error?.errorMessage || error?.message || error);
      if (!/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|USER_ID_INVALID/i.test(message)) throw error;
    }

    // Clear the ban after removal so this bot is not retained as a banned
    // participant. It still remains completely outside the vault.
    try {
      await client.invoke(new Api.channels.EditBanned({
        channel,
        participant: botPeer,
        bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
      }));
    } catch (_) {}
    return true;
  } finally {
    await client.disconnect();
  }
}

module.exports = {
  createPrivateUserStorageGroup,
  ensurePrivateUserStorageBotAbsent,
  masterStorageReady,
};
