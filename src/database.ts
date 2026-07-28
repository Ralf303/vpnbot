import { PrismaPg } from "@prisma/adapter-pg";
import type { User, VpnConfig, LegacyClient } from "./generated/prisma/client.js";
import { PrismaClient } from "./generated/prisma/client.js";
import type { LegacyClientRecord, ServerKey, UserRecord, VpnConfigRecord } from "./domain.js";

function mapUser(row: User): UserRecord {
  return {
    id: row.id,
    telegramId: row.telegramId,
    username: row.username,
    firstName: row.firstName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapConfig(row: VpnConfig): VpnConfigRecord {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    clientName: row.clientName,
    serverKey: row.serverKey,
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    isLegacy: row.isLegacy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    hiddenAt: row.hiddenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapLegacy(row: LegacyClient): LegacyClientRecord {
  return {
    id: row.id,
    serverKey: row.serverKey,
    clientName: row.clientName,
    assignedConfigId: row.assignedConfigId,
    discoveredAt: row.discoveredAt.toISOString(),
  };
}

function configData(config: VpnConfigRecord) {
  return {
    id: config.id,
    userId: config.userId,
    displayName: config.displayName,
    clientName: config.clientName,
    serverKey: config.serverKey,
    expiresAt: new Date(config.expiresAt),
    status: config.status,
    isLegacy: config.isLegacy,
    revokedAt: config.revokedAt ? new Date(config.revokedAt) : null,
    hiddenAt: new Date(config.hiddenAt),
    createdAt: new Date(config.createdAt),
    updatedAt: new Date(config.updatedAt),
  };
}

export class AppDatabase {
  readonly prisma: PrismaClient;

  constructor(databaseUrl: string) {
    const adapter = new PrismaPg({ connectionString: databaseUrl, max: 5 });
    this.prisma = new PrismaClient({ adapter });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async upsertUser(input: { telegramId: string; username?: string; firstName: string }): Promise<UserRecord> {
    const row = await this.prisma.user.upsert({
      where: { telegramId: input.telegramId },
      create: {
        telegramId: input.telegramId,
        username: input.username ?? null,
        firstName: input.firstName,
      },
      update: {
        username: input.username ?? null,
        firstName: input.firstName,
      },
    });
    return mapUser(row);
  }

  async getUserByTelegramId(telegramId: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { telegramId } });
    return row ? mapUser(row) : null;
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? mapUser(row) : null;
  }

  async searchUsers(query: string): Promise<UserRecord[]> {
    const normalized = query.trim().replace(/^@/, "");
    const rows = await this.prisma.user.findMany({
      where: {
        OR: [
          { telegramId: normalized },
          { username: { equals: normalized, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });
    return rows.map(mapUser);
  }

  async insertConfig(config: VpnConfigRecord): Promise<void> {
    await this.prisma.vpnConfig.create({ data: configData(config) });
  }

  async insertConfigAndAssignLegacy(config: VpnConfigRecord, legacyId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const legacy = await tx.legacyClient.findFirst({
        where: { id: legacyId, assignedConfigId: null },
        select: { id: true },
      });
      if (!legacy) throw new Error("Этот клиент уже привязан");
      await tx.vpnConfig.create({ data: configData(config) });
      await tx.legacyClient.update({ where: { id: legacyId }, data: { assignedConfigId: config.id } });
    });
  }

  async getConfig(id: string): Promise<VpnConfigRecord | null> {
    const row = await this.prisma.vpnConfig.findUnique({ where: { id } });
    return row ? mapConfig(row) : null;
  }

  async listVisibleConfigs(userId: number, now = new Date()): Promise<VpnConfigRecord[]> {
    const rows = await this.prisma.vpnConfig.findMany({
      where: { userId, status: { not: "revoked" }, hiddenAt: { gt: now } },
      orderBy: [{ expiresAt: "desc" }, { createdAt: "desc" }],
    });
    return rows.map(mapConfig);
  }

  async listConfigsForUserAdmin(userId: number): Promise<VpnConfigRecord[]> {
    const rows = await this.prisma.vpnConfig.findMany({
      where: { userId, status: { not: "revoked" } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapConfig);
  }

  async listReminderCandidates(): Promise<Array<{ config: VpnConfigRecord; user: UserRecord }>> {
    const rows = await this.prisma.vpnConfig.findMany({
      where: { status: "active" },
      include: { user: true },
    });
    return rows.map((row) => ({ config: mapConfig(row), user: mapUser(row.user) }));
  }

  async listActiveConfigs(): Promise<VpnConfigRecord[]> {
    return (await this.prisma.vpnConfig.findMany({ where: { status: "active" } })).map(mapConfig);
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await this.prisma.vpnConfig.update({ where: { id }, data: { displayName } });
  }

  async updateExpiry(id: string, expiresAt: string, hiddenAt: string): Promise<void> {
    await this.prisma.vpnConfig.update({
      where: { id },
      data: {
        expiresAt: new Date(expiresAt),
        hiddenAt: new Date(hiddenAt),
        status: "active",
        revokedAt: null,
      },
    });
  }

  async replaceClient(id: string, clientName: string, expiresAt: string, hiddenAt: string): Promise<void> {
    await this.prisma.vpnConfig.update({
      where: { id },
      data: {
        clientName,
        serverKey: "new",
        isLegacy: false,
        expiresAt: new Date(expiresAt),
        hiddenAt: new Date(hiddenAt),
        status: "active",
        revokedAt: null,
      },
    });
  }

  async restoreLegacyClient(id: string, clientName: string, expiresAt: string, hiddenAt: string): Promise<void> {
    await this.prisma.vpnConfig.update({
      where: { id },
      data: {
        clientName,
        serverKey: "old",
        isLegacy: true,
        expiresAt: new Date(expiresAt),
        hiddenAt: new Date(hiddenAt),
        status: "active",
        revokedAt: null,
      },
    });
  }

  async markExpired(id: string): Promise<void> {
    await this.prisma.vpnConfig.update({
      where: { id },
      data: { status: "expired", revokedAt: new Date() },
    });
  }

  async markRevoked(id: string): Promise<void> {
    const now = new Date();
    await this.prisma.vpnConfig.update({
      where: { id },
      data: { status: "revoked", revokedAt: now, hiddenAt: now },
    });
  }

  async notificationWasSent(configId: string, kind: string, localDate: string): Promise<boolean> {
    return Boolean(await this.prisma.notification.findUnique({
      where: { configId_kind_localDate: { configId, kind, localDate } },
      select: { id: true },
    }));
  }

  async markNotificationSent(configId: string, kind: string, localDate: string): Promise<void> {
    await this.prisma.notification.upsert({
      where: { configId_kind_localDate: { configId, kind, localDate } },
      create: { configId, kind, localDate },
      update: {},
    });
  }

  async syncLegacyClients(serverKey: ServerKey, clientNames: string[]): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.legacyClient.deleteMany({ where: { serverKey, assignedConfigId: null } });
      for (const clientName of clientNames) {
        await tx.legacyClient.upsert({
          where: { serverKey_clientName: { serverKey, clientName } },
          create: { serverKey, clientName, discoveredAt: now },
          update: { discoveredAt: now },
        });
      }
    });
  }

  async listUnassignedLegacyClients(serverKey: ServerKey): Promise<LegacyClientRecord[]> {
    const rows = await this.prisma.legacyClient.findMany({
      where: { serverKey, assignedConfigId: null },
      orderBy: { clientName: "asc" },
    });
    return rows.map(mapLegacy);
  }

  async getLegacyClient(id: number): Promise<LegacyClientRecord | null> {
    const row = await this.prisma.legacyClient.findUnique({ where: { id } });
    return row ? mapLegacy(row) : null;
  }

  async nextConfigNumber(userId: number): Promise<number> {
    return await this.prisma.vpnConfig.count({ where: { userId } }) + 1;
  }

  async stats(): Promise<{ users: number; active: number; expired: number; old: number; new: number }> {
    const now = new Date();
    const [users, active, expired, old, newCount] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.vpnConfig.count({ where: { status: "active", expiresAt: { gt: now } } }),
      this.prisma.vpnConfig.count({
        where: { status: { not: "revoked" }, expiresAt: { lte: now }, hiddenAt: { gt: now } },
      }),
      this.prisma.vpnConfig.count({ where: { status: { not: "revoked" }, serverKey: "old" } }),
      this.prisma.vpnConfig.count({ where: { status: { not: "revoked" }, serverKey: "new" } }),
    ]);
    return { users, active, expired, old, new: newCount };
  }
}
