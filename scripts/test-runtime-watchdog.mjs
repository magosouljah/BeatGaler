import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watchdogPath = path.join(root, "src-tauri", "direct-transport", "runtime-watchdog.cjs");

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const parent = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120)"], { stdio: "ignore" });
const watchdog = spawn(process.execPath, [watchdogPath, String(parent.pid), String(child.pid)], { stdio: "ignore" });

try {
  const parentExited = await waitForExit(parent, 2000);
  if (!parentExited) throw new Error("dummy BeatGaler parent did not exit");
  const childExited = await waitForExit(child, 4000);
  if (!childExited) throw new Error("watchdog did not terminate the owned data-plane child after parent exit");
  const watchdogExited = await waitForExit(watchdog, 2000);
  if (!watchdogExited) throw new Error("watchdog did not exit after cleaning the child");
  console.log("PASS crash watchdog terminates the exact owned child after parent disappearance");
} finally {
  try { child.kill("SIGKILL"); } catch {}
  try { parent.kill("SIGKILL"); } catch {}
  try { watchdog.kill("SIGKILL"); } catch {}
}
