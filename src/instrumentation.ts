/**
 * Runs once when the server boots. Next.js calls this automatically.
 *
 * This is what makes the calling-hours guard real: the scheduler ticks every
 * minute, so a run queued at 9pm sits until 9am the next morning and then
 * starts dialling on its own, without the dashboard being open.
 */

export async function register() {
  // Only in the Node.js server runtime — not the edge runtime used by middleware.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("./lib/dispatcher");
  startScheduler();
}
