import { startBot, registerCommands } from "./src/discordClient.js";
import { startHealth } from "./src/health.js";

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
});

(async function main() {
  startHealth(3000);
  // Force command registration on boot according to REGISTER_MODE
  await registerCommands(); // uses process.env.REGISTER_MODE
  await startBot();
})();
