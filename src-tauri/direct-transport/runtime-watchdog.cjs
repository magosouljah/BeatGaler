"use strict";

// BeatGaler crash watchdog for the local data-plane process.
// No credentials are passed here: only process IDs. If the BeatGaler parent
// disappears (Force Quit / crash / kill -9), terminate the owned Bot API child
// so a later app launch never inherits an orphan runtime.
const parentPid = Number(process.argv[2]);
const childPid = Number(process.argv[3]);

if (!Number.isInteger(parentPid) || parentPid <= 0 || !Number.isInteger(childPid) || childPid <= 0) {
  process.exit(2);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function terminateChildAndExit() {
  try { process.kill(childPid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 1500;
  const finish = () => {
    if (processExists(childPid) && Date.now() < deadline) {
      setTimeout(finish, 100);
      return;
    }
    if (processExists(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    process.exit(0);
  };
  finish();
}

const timer = setInterval(() => {
  if (!processExists(childPid)) {
    clearInterval(timer);
    process.exit(0);
    return;
  }
  if (!processExists(parentPid)) {
    clearInterval(timer);
    terminateChildAndExit();
  }
}, 500);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
