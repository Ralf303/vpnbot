import "dotenv/config";
import { loadConfig } from "./config.js";
import { ConfigService } from "./config-service.js";
import { AppDatabase } from "./database.js";
import { createBot } from "./bot.js";
import { BackgroundJobs } from "./jobs.js";
import { OpenVpnGateway } from "./openvpn.js";

const config = loadConfig();
const db = new AppDatabase(config.databaseUrl);
const vpn = new OpenVpnGateway(config.servers);
const configService = new ConfigService(db, vpn);
const { bot } = createBot(config, db, vpn, configService);
const jobs = new BackgroundJobs(bot, db, vpn, config);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(`Получен ${signal}, завершаю работу`);
  jobs.stop();
  await bot.stop();
  await db.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await bot.api.setMyCommands([
    { command: "start", description: "Открыть главное меню" },
  ]);
  jobs.start();
  console.info("VPN-бот запущен");
  await bot.start({ allowed_updates: ["message", "callback_query"] });
} catch (error) {
  console.error("Не удалось запустить VPN-бота", error);
  jobs.stop();
  await db.close();
  process.exitCode = 1;
}
