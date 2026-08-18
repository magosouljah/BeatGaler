require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");

let TelegramClient, StringSession, qrcode;
try {
  ({ TelegramClient } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
} catch {
  console.error("Missing GramJS. Run: npm install");
  process.exit(1);
}

try {
  qrcode = require("qrcode-terminal");
} catch {
  console.error("Missing qrcode-terminal. Run: npm install qrcode-terminal");
  process.exit(1);
}

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = String(process.env.TELEGRAM_API_HASH || "");

if (!Number.isFinite(apiId) || !apiHash) {
  console.error("TELEGRAM_API_ID and TELEGRAM_API_HASH must be configured first.");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (text) => new Promise((resolve) => rl.question(text, resolve));

function renderQr(code) {
  const token = code.token.toString("base64url");
  const loginUrl = `tg://login?token=${token}`;

  console.clear();
  console.log("===============================================");
  console.log(" BeatGaler MASTER Telegram — QR login");
  console.log("===============================================");
  console.log("");
  console.log("On your PHONE:");
  console.log("Telegram -> Settings -> Devices -> Link Desktop Device");
  console.log("");
  console.log("Scan this QR code:");
  console.log("");

  qrcode.generate(loginUrl, { small: true });

  console.log("");
  if (code.expires) {
    const expiresAt = new Date(Number(code.expires) * 1000);
    console.log(`QR expires: ${expiresAt.toLocaleTimeString()}`);
  }
  console.log("If it expires, BeatGaler will print a fresh QR automatically.");
  console.log("");
  console.log("Waiting for Telegram approval...");
}

(async () => {
  const sessionPath = path.join(__dirname, "master-session.txt");

  // Always create a NEW MASTER authorization. A stale session file must not
  // silently influence setup.
  const client = new TelegramClient(
    new StringSession(""),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  try {
    await client.connect();

    console.log("Connected to Telegram. Creating QR login...");

    const user = await client.signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async (code) => {
          renderQr(code);
        },
        password: async (hint) => {
          console.log("");
          console.log("Telegram requires your 2FA password.");
          if (hint) console.log(`Hint: ${hint}`);
          return await ask("Telegram 2FA password: ");
        },
        onError: async (error) => {
          console.error("");
          console.error("Telegram QR login error:", error?.message || error);
          // true means stop the auth process instead of looping forever.
          return true;
        },
      }
    );

    const authorized = await client.checkAuthorization();
    if (!authorized) {
      throw new Error("QR was accepted but Telegram session is not authorized.");
    }

    const savedSession = client.session.save();
    if (!savedSession || !String(savedSession).trim()) {
      throw new Error("Telegram authorized the account but returned an empty session.");
    }

    // Write atomically so a failed setup never leaves a half-written session.
    const tempPath = `${sessionPath}.tmp`;
    fs.writeFileSync(tempPath, savedSession, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, sessionPath);

    console.clear();
    console.log("===============================================");
    console.log(" BeatGaler MASTER account connected");
    console.log("===============================================");
    console.log("");
    console.log(`Telegram user: ${user?.firstName || ""} ${user?.lastName || ""}`.trim());
    if (user?.username) console.log(`Username: @${user.username}`);
    console.log(`Session saved to: ${sessionPath}`);
    console.log("");
    console.log("Do NOT upload or share master-session.txt.");
    console.log("You can now start BeatGaler Cloud.");
  } finally {
    try { rl.close(); } catch {}
    await client.disconnect();
  }
})().catch((error) => {
  console.error("");
  console.error("Master account setup failed:", error?.message || error);
  try { rl.close(); } catch {}
  process.exit(1);
});
