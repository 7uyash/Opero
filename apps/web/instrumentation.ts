/**
 * Runs once when the server starts: refuse to serve with a broken or unsafe configuration
 * (missing keys, http APP_URL in production, …) instead of failing on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { config } = await import("@lfm/core");
  try {
    config();
  } catch (err) {
    console.error(`\n${(err as Error).message}\n\nThe server will not start until this is fixed.\n`);
    // Exit so Docker/systemd report a failed start rather than a server that answers with errors.
    process.exit(1);
  }
}
