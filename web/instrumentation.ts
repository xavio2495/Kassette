// Starts the background execution watcher once when the server boots, so pending
// copy/fade trades keep getting confirmed against Coston2 even if nobody's browser tab
// is open to poll for them. See lib/executionWatcher.ts for what it actually does and
// its limits (a live process, not a durable job — see that file's header).
//
// `register()` also runs in the Edge runtime when one is configured; the watcher needs
// `node:sqlite` and a real network client, so it's skipped there.

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { startExecutionWatcher } = await import("./lib/executionWatcher");
  startExecutionWatcher();
}
