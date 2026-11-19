// Called once when the server starts. Runs ISA's background worker in the Node runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/runtime");
    startWorker();
  }
}
