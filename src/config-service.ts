import { randomBytes, randomUUID } from "node:crypto";
import { AppDatabase } from "./database.js";
import type {
  LegacyClientRecord,
  UserRecord,
  VpnConfigRecord,
} from "./domain.js";
import { hiddenAtFromExpiry, isExpired } from "./time.js";

export interface VpnOperations {
  createClient(serverKey: "new" | "old", clientName: string): Promise<Buffer>;
  downloadClient(serverKey: "new" | "old", clientName: string): Promise<Buffer>;
  revokeClient(serverKey: "new" | "old", clientName: string): Promise<void>;
}

function technicalClientName(telegramId: string): string {
  return `tg${telegramId}_${randomBytes(5).toString("hex")}`.slice(0, 64);
}

export class ConfigService {
  constructor(
    private readonly db: AppDatabase,
    private readonly vpn: VpnOperations
  ) {}

  async issue(user: UserRecord, expiresAt: string): Promise<VpnConfigRecord> {
    const clientName = technicalClientName(user.telegramId);
    await this.vpn.createClient("new", clientName);
    const now = new Date().toISOString();
    const record: VpnConfigRecord = {
      id: randomUUID(),
      userId: user.id,
      displayName: `VPN #${await this.db.nextConfigNumber(user.id)}`,
      clientName,
      serverKey: "new",
      expiresAt,
      status: "active",
      isLegacy: false,
      revokedAt: null,
      hiddenAt: hiddenAtFromExpiry(expiresAt),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.db.insertConfig(record);
      return record;
    } catch (error) {
      await this.vpn
        .revokeClient("new", clientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать клиент после ошибки БД",
            rollbackError
          );
        });
      throw error;
    }
  }

  async bindLegacy(
    user: UserRecord,
    legacy: LegacyClientRecord,
    expiresAt: string
  ): Promise<VpnConfigRecord> {
    if (legacy.assignedConfigId) throw new Error("Этот клиент уже привязан");
    const now = new Date().toISOString();
    const record: VpnConfigRecord = {
      id: randomUUID(),
      userId: user.id,
      displayName: `VPN #${await this.db.nextConfigNumber(user.id)}`,
      clientName: legacy.clientName,
      serverKey: legacy.serverKey,
      expiresAt,
      status: "active",
      isLegacy: true,
      revokedAt: null,
      hiddenAt: hiddenAtFromExpiry(expiresAt),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insertConfigAndAssignLegacy(record, legacy.id);
    return record;
  }

  async download(config: VpnConfigRecord): Promise<Buffer> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      throw new Error("Срок действия конфига истёк");
    }
    if (config.isLegacy)
      throw new Error("Старый конфиг необходимо сначала перенести");
    return this.vpn.downloadClient(config.serverKey, config.clientName);
  }

  async migrateLegacy(config: VpnConfigRecord): Promise<Buffer> {
    if (!config.isLegacy || config.serverKey !== "old")
      throw new Error("Конфиг уже находится на новом сервере");
    if (config.status !== "active" || isExpired(config.expiresAt))
      throw new Error("Сначала продлите срок действия конфига");

    const newClientName = technicalClientName(String(config.userId));
    const file = await this.vpn.createClient("new", newClientName);
    try {
      await this.db.replaceClient(
        config.id,
        newClientName,
        config.expiresAt,
        config.hiddenAt
      );
    } catch (error) {
      await this.vpn
        .revokeClient("new", newClientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать новый клиент после ошибки записи миграции",
            rollbackError
          );
        });
      throw error;
    }

    try {
      await this.vpn.revokeClient("old", config.clientName);
      return file;
    } catch (error) {
      await this.db.restoreLegacyClient(
        config.id,
        config.clientName,
        config.expiresAt,
        config.hiddenAt
      );
      await this.vpn
        .revokeClient("new", newClientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать новый клиент после отката миграции",
            rollbackError
          );
        });
      throw error;
    }
  }

  async changeExpiry(
    config: VpnConfigRecord,
    expiresAt: string
  ): Promise<VpnConfigRecord> {
    const hiddenAt = hiddenAtFromExpiry(expiresAt);
    if (config.status === "expired" || config.revokedAt) {
      const newClientName = technicalClientName(String(config.userId));
      await this.vpn.createClient("new", newClientName);
      try {
        await this.db.replaceClient(config.id, newClientName, expiresAt, hiddenAt);
      } catch (error) {
        await this.vpn
          .revokeClient("new", newClientName)
          .catch((rollbackError: unknown) => {
            console.error(
              "Не удалось отозвать новый клиент после ошибки продления",
              rollbackError
            );
          });
        throw error;
      }
    } else {
      await this.db.updateExpiry(config.id, expiresAt, hiddenAt);
    }
    return (await this.db.getConfig(config.id))!;
  }

  async revoke(config: VpnConfigRecord): Promise<void> {
    if (config.status !== "expired" && !config.revokedAt) {
      await this.vpn.revokeClient(config.serverKey, config.clientName);
    }
    await this.db.markRevoked(config.id);
  }
}
