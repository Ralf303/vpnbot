import type { Bot } from "grammy";
import { setTimeout as delay } from "node:timers/promises";

export async function runTelegramWithRetry(bot: Bot, signal: AbortSignal,
  pause: (ms: number) => Promise<unknown> = ms => delay(ms, undefined, { signal })): Promise<void> {
  while (!signal.aborted) {
    try {
      await bot.api.setMyCommands([{ command: "start", description: "Открыть главное меню" }]);
      if (signal.aborted) break;
      await bot.start({ allowed_updates: ["message", "callback_query"] });
    } catch {
      if (!signal.aborted) console.warn("Telegram недоступен; повтор подключения через 5 секунд. VK продолжает работать.");
    }
    if (!signal.aborted) await pause(5000).catch(() => {});
  }
}
