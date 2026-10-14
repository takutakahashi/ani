export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initializeConfig } = await import("@/src/config/runtime");
      await initializeConfig();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "config.load_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(2);
    }
  }
}
