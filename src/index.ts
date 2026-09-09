import "dotenv/config";
import { loadConfig } from "./config.js";
import { ConfigService } from "./config-service.js";
import { AppDatabase } from "./database.js";
import { createBot } from "./bot.js";
import { BackgroundJobs } from "./jobs.js";
import { OpenVpnGateway } from "./openvpn.js";
import { ServerManager } from "./server-manager.js";
import { TrafficService } from "./traffic-service.js";
import { VkApiClient } from "./vk-api.js";
import { VkBot } from "./vk-bot.js";
import { EgressService } from "./egress-service.js";
import { runTelegramWithRetry } from "./telegram-runtime.js";

const config = loadConfig();
const db = new AppDatabase(config.databaseUrl);
const vpn = new OpenVpnGateway(config.envServers, (key) =>
  key === "new" ? "Новый сервер" : key === "old" ? "Старый сервер" : key
);
const serverManager = new ServerManager(db, vpn, config);
const egress = config.entryServerKey ? new EgressService(db, serverManager, config.entryServerKey) : undefined;
const configService = new ConfigService(db, vpn, serverManager, config.vpnProfile);
const trafficService = new TrafficService(db, vpn, serverManager);
const vkApi = config.vk ? new VkApiClient(config.vk.token, config.vk.groupId) : undefined;
const { bot } = createBot(config, db, configService, trafficService, serverManager, vkApi, egress);
const jobs = new BackgroundJobs(bot, db, vpn, config, trafficService, serverManager);
const vkBot = vkApi
  ? new VkBot(
      vkApi,
      db,
      configService,
      trafficService,
      serverManager,
      config.timezone,
      { egress, adminTelegramId: config.adminTelegramId, adminVkId: config.adminVkId }
    )
  : null;

for (const envServer of Object.values(config.envServers)) {
  await db
    .upsertBuiltinServer({
      key: envServer.key,
      name: envServer.name,
      host: envServer.host,
      port: envServer.port,
      sshUser: envServer.username,
      sshPrivateKey: envServer.privateKey.toString("utf8"),
      hostFingerprint: envServer.hostFingerprint,
    })
    .catch((error) =>
      console.error(`Не удалось синхронизировать сервер ${envServer.key}`, error)
    );
}

let stopping = false;
const messengerController = new AbortController();
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  messengerController.abort();
  console.info(`Получен ${signal}, завершаю работу`);
  jobs.stop();
  vkBot?.stop();
  if (bot.isRunning()) await bot.stop();
  await db.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  jobs.start();
  console.info("VPN-бот запущен");
  await Promise.all([
    runTelegramWithRetry(bot, messengerController.signal),
    ...(vkBot ? [vkBot.start()] : []),
  ]);
} catch (error) {
  console.error("Не удалось запустить VPN-бота", error);
  jobs.stop();
  vkBot?.stop();
  await db.close();
  process.exitCode = 1;
}
