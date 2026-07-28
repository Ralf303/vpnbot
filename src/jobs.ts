import type { Bot } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import { DateTime } from "luxon";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { OpenVpnGateway } from "./openvpn.js";
import { daysUntilExpiry, formatDate, isRevocationDue } from "./time.js";

export class BackgroundJobs {
  private readonly tasks: ScheduledTask[] = [];
  private remindersRunning = false;
  private revocationsRunning = false;

  constructor(
    private readonly bot: Bot,
    private readonly db: AppDatabase,
    private readonly vpn: OpenVpnGateway,
    private readonly config: AppConfig
  ) {}

  start(): void {
    this.tasks.push(
      cron.schedule(
        `0 ${this.config.reminderHour} * * *`,
        () => void this.sendReminders(),
        { timezone: this.config.timezone }
      )
    );
    this.tasks.push(
      cron.schedule("5 * * * *", () => void this.revokeExpired(), {
        timezone: this.config.timezone,
      })
    );
    void this.sendReminders();
    void this.revokeExpired();
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
  }

  async sendReminders(now = DateTime.now()): Promise<void> {
    if (this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      const localDate = now.setZone(this.config.timezone).toISODate()!;
      for (const { config, user } of await this.db.listReminderCandidates()) {
        const days = daysUntilExpiry(
          config.expiresAt,
          this.config.timezone,
          now
        );
        if (![1, 2, 3].includes(days)) continue;
        const kind = `expires_${days}`;
        if (await this.db.notificationWasSent(config.id, kind, localDate)) continue;

        try {
          await this.bot.api.sendMessage(
            user.telegramId,
            `Срок действия конфига «${config.displayName}» закончится через ${days} ${dayWord(days)} — ${formatDate(config.expiresAt, this.config.timezone)}. Для продления свяжитесь с администратором.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Продлить", url: this.config.contactUrl }],
                ],
              },
            }
          );
          await this.db.markNotificationSent(config.id, kind, localDate);
        } catch (error) {
          console.error(
            `Не удалось отправить напоминание пользователю ${user.telegramId}`,
            error
          );
        }
      }
    } finally {
      this.remindersRunning = false;
    }
  }

  async revokeExpired(now = DateTime.now()): Promise<void> {
    if (this.revocationsRunning) return;
    this.revocationsRunning = true;
    try {
      for (const config of await this.db.listActiveConfigs()) {
        if (!isRevocationDue(config.expiresAt, now)) continue;
        try {
          await this.vpn.revokeClient(config.serverKey, config.clientName);
          await this.db.markExpired(config.id);
        } catch (error) {
          console.error(
            `Не удалось автоматически отозвать ${config.clientName}`,
            error
          );
        }
      }
    } finally {
      this.revocationsRunning = false;
    }
  }
}

function dayWord(days: number): string {
  return days === 1 ? "день" : "дня";
}
