import { startBot, registerCommands } from "./src/discordClient.js";
import { startHealth } from "./src/health.js";
import { log } from "./src/logger.js";

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason instanceof Error ? reason : { reason });
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
});

(async function main() {
  log.info("bot starting");
  startHealth(3000);
  // Force command registration on boot according to REGISTER_MODE
  await registerCommands(); // uses process.env.REGISTER_MODE
  await startBot();
})();
