import type { AppConfig } from "./config.js";
import type { ServerManager } from "./server-manager.js";
import { runSshCommand } from "./ssh-run.js";

/** One WireGuard peer and one stable profile per database user. */
export class GameProfileService {
  constructor(
    private readonly config: AppConfig,
    private readonly servers: ServerManager
  ) {}

  get ready(): boolean {
    return Boolean(this.config.entryServerKey && this.config.gameSshHost);
  }

  async enable(userId: number): Promise<Buffer> {
    return this.execute("enable", userId);
  }

  async download(userId: number): Promise<Buffer> {
    return this.execute("get", userId);
  }

  async disable(userId: number): Promise<void> {
    await this.execute("disable", userId);
  }

  private async execute(action: "enable" | "get" | "disable", userId: number): Promise<Buffer> {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Некорректный пользователь");
    if (!this.config.entryServerKey || !this.config.gameSshHost) {
      throw new Error("Игровой профиль не настроен");
    }
    const target = await this.servers.resolveTarget(this.config.entryServerKey);
    if (!target) throw new Error("Московский сервер недоступен");
    return runSshCommand({
      host: this.config.gameSshHost,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      hostFingerprint: target.hostFingerprint,
      command: `sudo /usr/local/sbin/vpnbot-game-helper ${action} ${userId}`,
      timeoutMs: 30_000,
      proxyUrl: undefined,
    });
  }
}
