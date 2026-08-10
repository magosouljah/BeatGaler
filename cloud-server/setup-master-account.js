require("dotenv").config();
const fs = require("fs");
const path = require("path");
const readline = require("readline");

let TelegramClient, StringSession;
try {
  ({ TelegramClient } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
} catch {
  console.error('Missing GramJS. Run: npm install telegram');
  process.exit(1);
}

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = String(process.env.TELEGRAM_API_HASH || "");
if (!Number.isFinite(apiId) || !apiHash) {
  console.error("TELEGRAM_API_ID and TELEGRAM_API_HASH must be configured first.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (text) => new Promise(resolve => rl.question(text, resolve));

(async () => {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  try {
    await client.start({
      phoneNumber: async () => (await ask("Master Telegram phone number (with country code): ")).trim(),
      password: async () => await ask("Telegram 2FA password (if enabled): "),
      phoneCode: async () => (await ask("Telegram login code: ")).trim(),
      onError: (error) => console.error("Telegram login:", error?.message || error),
    });

    const session = client.session.save();
    const sessionPath = path.join(__dirname, "master-session.txt");
    fs.writeFileSync(sessionPath, session, { encoding: "utf8", mode: 0o600 });
    console.log(`Master account session saved to ${sessionPath}`);
    console.log("Do not upload master-session.txt to GitHub or share it.");
  } finally {
    rl.close();
    await client.disconnect();
  }
})().catch(error => {
  console.error(error?.message || error);
  rl.close();
  process.exit(1);
});
