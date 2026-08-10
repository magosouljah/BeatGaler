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
    throw new Error('Missing GramJS. Run "cd cloud-server" then "npm install telegram".');
  }

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "");
  const session = readSession();
  if (!Number.isFinite(apiId) || !apiHash || !session) {
    throw new Error("Master Telegram account is not configured. Run node setup-master-account.js.");
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error("Saved master Telegram session is no longer authorized.");
  }
  return { client, Api };
}

async function createPrivateUserStorageGroup({ username, accountId, botUsername }) {
  const { client, Api } = await openMasterClient();
  try {
    // The Telegram storage group uses the exact BeatGaler username as its title.
    // Telegram allows duplicate private group titles, so no account suffix is needed.
    const title = String(username || "user").trim();

    const created = await client.invoke(new Api.channels.CreateChannel({
      title,
      about: "Private BeatGaler storage. Managed automatically. End users are not members.",
      megagroup: true,
      forum: true,
    }));

    const channel = (created.chats || []).find(chat => chat && chat.id);
    if (!channel) throw new Error("Telegram created the group but returned no channel entity.");

    // Forum supergroups always start with General as topic id 1. Rename it to
    // #general and pin the topic immediately so the system/index area stays at
    // the top of every newly provisioned BeatGaler storage group.
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

    const botPeer = await client.getInputEntity(String(botUsername || "").replace(/^@/, ""));
    try {
      await client.invoke(new Api.channels.InviteToChannel({
        channel,
        users: [botPeer],
      }));
    } catch (error) {
      const message = String(error?.errorMessage || error?.message || error);
      if (!/USER_ALREADY_PARTICIPANT/i.test(message)) throw error;
    }

    await client.invoke(new Api.channels.EditAdmin({
      channel,
      userId: botPeer,
      adminRights: new Api.ChatAdminRights({
        changeInfo: false,
        postMessages: false,
        editMessages: false,
        deleteMessages: true,
        banUsers: false,
        inviteUsers: true,
        pinMessages: true,
        addAdmins: false,
        anonymous: false,
        manageCall: false,
        other: true,
        manageTopics: true,
        postStories: false,
        editStories: false,
        deleteStories: false,
      }),
      rank: "BeatGaler",
    }));

    return {
      title,
      channelId: String(channel.id),
      botApiChatId: channelIdToBotApiChatId(channel.id),
    };
  } finally {
    await client.disconnect();
  }
}

module.exports = {
  createPrivateUserStorageGroup,
  masterStorageReady,
};
