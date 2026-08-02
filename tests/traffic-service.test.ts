import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/database.js";
import type {
  CompletedTrafficSession,
  ServerKey,
  TrafficSnapshot,
  VpnConfigRecord,
} from "../src/domain.js";
import { OpenVpnGateway } from "../src/openvpn.js";
import { TrafficService } from "../src/traffic-service.js";
import { createCleanDatabase } from "./database-fixture.js";

class FakeTrafficGateway {
  snapshot: TrafficSnapshot = { active: [], completed: [] };

  isConfigured(serverKey: ServerKey): boolean {
    return serverKey === "new";
  }

  async trafficSessions(): Promise<TrafficSnapshot> {
    return this.snapshot;
  }
}

let db: AppDatabase;
let gateway: FakeTrafficGateway;
let service: TrafficService;
let config: VpnConfigRecord;

beforeEach(async () => {
  db = await createCleanDatabase();
  gateway = new FakeTrafficGateway();
  service = new TrafficService(
    db,
    gateway as unknown as OpenVpnGateway
  );
  const user = await db.upsertUser({ telegramId: "500", firstName: "Иван" });
  const now = new Date().toISOString();
  config = {
    id: randomUUID(),
    userId: user.id,
    displayName: "Телефон",
    clientName: "abcdefghijkl",
    serverKey: "new",
    expiresAt: "2027-01-01T20:59:59.999Z",
    status: "active",
    isLegacy: false,
    revokedAt: null,
    hiddenAt: "2027-01-11T20:59:59.999Z",
    createdAt: now,
    updatedAt: now,
  };
  await db.insertConfig(config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

describe("TrafficService", () => {
  it("складывает завершённый и активный трафик конфига без повторного импорта", async () => {
    gateway.snapshot = {
      completed: [
        {
          eventId: "abcdefghijkl_1000_1100_1234",
          clientName: config.clientName,
          connectedAt: 1000,
          disconnectedAt: 1100,
          uploadBytes: 100,
          downloadBytes: 200,
        },
      ],
      active: [
        {
          clientName: config.clientName,
          connectedAt: 1200,
          uploadBytes: 10,
          downloadBytes: 20,
        },
      ],
    };

    expect(await service.forConfig(config)).toEqual({
      uploadBytes: 110,
      downloadBytes: 220,
      totalBytes: 330,
    });
    expect(await service.forConfig(config)).toEqual({
      uploadBytes: 110,
      downloadBytes: 220,
      totalBytes: 330,
    });
    expect(await db.prisma.trafficEvent.count()).toBe(1);
  });

  it("показывает общую статистику серверов", async () => {
    gateway.snapshot = {
      completed: [],
      active: [
        {
          clientName: config.clientName,
          connectedAt: 1200,
          uploadBytes: 1024,
          downloadBytes: 2048,
        },
      ],
    };

    const totals = await service.all();
    expect(totals.total.totalBytes).toBe(3072);
    expect(totals.servers.new.activeConnections).toBe(1);
    expect(totals.servers.old.liveAvailable).toBe(false);
  });

  it("показывает активные подключения даже при ошибке импорта истории", async () => {
    gateway.snapshot = {
      completed: [trafficEvent("failed_import", config.clientName, 1000)],
      active: [
        {
          clientName: config.clientName,
          connectedAt: 1200,
          uploadBytes: 10,
          downloadBytes: 20,
        },
      ],
    };
    vi.spyOn(db, "importTrafficEvents").mockRejectedValue(new Error("timeout"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const totals = await service.all();

    expect(totals.servers.new.liveAvailable).toBe(true);
    expect(totals.servers.new.activeConnections).toBe(1);
    log.mockRestore();
  });

  it("импортирует историю пакетами и не создаёт дубликаты", async () => {
    const events = Array.from({ length: 1_200 }, (_, index) =>
      trafficEvent(`bulk_${index}`, config.clientName, 1000 + index)
    );

    await db.importTrafficEvents("new", events);
    await db.importTrafficEvents("new", events);

    expect(await db.prisma.trafficEvent.count()).toBe(events.length);
  });

  it("привязывает ранее импортированный трафик после появления конфига", async () => {
    const clientName = "late_client";
    const event = trafficEvent("late_event", clientName, 2000);
    await db.importTrafficEvents("new", [event]);
    const lateConfig: VpnConfigRecord = {
      ...config,
      id: randomUUID(),
      displayName: "Поздний конфиг",
      clientName,
    };
    await db.insertConfig(lateConfig);

    await db.importTrafficEvents("new", [event]);

    await expect(db.trafficForConfig(lateConfig.id)).resolves.toEqual({
      uploadBytes: 100,
      downloadBytes: 200,
    });
  });
});

function trafficEvent(
  eventId: string,
  clientName: string,
  connectedAt: number
): CompletedTrafficSession {
  return {
    eventId,
    clientName,
    connectedAt,
    disconnectedAt: connectedAt + 60,
    uploadBytes: 100,
    downloadBytes: 200,
  };
}
