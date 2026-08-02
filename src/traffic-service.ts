import { AppDatabase } from "./database.js";
import type {
  ActiveTrafficSession,
  ServerKey,
  ServerTraffic,
  TrafficSnapshot,
  TrafficUsage,
  VpnConfigRecord,
} from "./domain.js";
import { OpenVpnGateway } from "./openvpn.js";

export interface ServerTrafficUsage extends TrafficUsage {
  activeConnections: number;
  liveAvailable: boolean;
}

export interface AllTrafficUsage {
  total: TrafficUsage;
  servers: Record<ServerKey, ServerTrafficUsage>;
}

export class TrafficService {
  constructor(
    private readonly db: AppDatabase,
    private readonly vpn: OpenVpnGateway
  ) {}

  async syncAll(): Promise<void> {
    await Promise.all(
      (["new", "old"] as const).map(async (serverKey) => {
        if (!this.vpn.isConfigured(serverKey)) return;
        try {
          await this.snapshot(serverKey);
        } catch (error) {
          console.error(`Не удалось синхронизировать трафик сервера ${serverKey}`, error);
        }
      })
    );
  }

  async forConfig(config: VpnConfigRecord): Promise<TrafficUsage> {
    let active: ActiveTrafficSession[] = [];
    try {
      if (this.vpn.isConfigured(config.serverKey)) {
        active = (await this.snapshot(config.serverKey)).active;
      }
    } catch (error) {
      console.error(`Не удалось получить активный трафик конфига ${config.id}`, error);
    }
    const [completed, names] = await Promise.all([
      this.db.trafficForConfig(config.id),
      this.db.clientNamesForConfig(config.id),
    ]);
    const knownNames = new Set([...names, config.clientName]);
    return usage(add(completed, sumActive(active, knownNames)));
  }

  async all(): Promise<AllTrafficUsage> {
    const activeByServer: Record<ServerKey, ActiveTrafficSession[]> = {
      new: [],
      old: [],
    };
    const liveAvailable: Record<ServerKey, boolean> = {
      new: false,
      old: false,
    };
    for (const serverKey of ["new", "old"] as const) {
      if (!this.vpn.isConfigured(serverKey)) continue;
      try {
        activeByServer[serverKey] = (await this.snapshot(serverKey)).active;
        liveAvailable[serverKey] = true;
      } catch (error) {
        console.error(`Не удалось получить активный трафик сервера ${serverKey}`, error);
      }
    }
    const completed = await this.db.completedTrafficByServer();
    const servers = {} as Record<ServerKey, ServerTrafficUsage>;
    for (const serverKey of ["new", "old"] as const) {
      const active = activeByServer[serverKey];
      servers[serverKey] = {
        ...usage(add(completed[serverKey], sumActive(active))),
        activeConnections: active.length,
        liveAvailable: liveAvailable[serverKey],
      };
    }
    return {
      total: usage(add(servers.new, servers.old)),
      servers,
    };
  }

  private async snapshot(serverKey: ServerKey): Promise<TrafficSnapshot> {
    const snapshot = await this.vpn.trafficSessions(serverKey);
    try {
      await this.db.importTrafficEvents(serverKey, snapshot.completed);
    } catch (error) {
      console.error(
        `Не удалось импортировать историю трафика сервера ${serverKey}`,
        error
      );
    }
    return snapshot;
  }
}

function sumActive(
  sessions: ActiveTrafficSession[],
  names?: ReadonlySet<string>
): ServerTraffic {
  return sessions.reduce<ServerTraffic>(
    (total, session) => {
      if (names && !names.has(session.clientName)) return total;
      total.uploadBytes += session.uploadBytes;
      total.downloadBytes += session.downloadBytes;
      return total;
    },
    { uploadBytes: 0, downloadBytes: 0 }
  );
}

function add(left: ServerTraffic, right: ServerTraffic): ServerTraffic {
  return {
    uploadBytes: left.uploadBytes + right.uploadBytes,
    downloadBytes: left.downloadBytes + right.downloadBytes,
  };
}

function usage(traffic: ServerTraffic): TrafficUsage {
  return {
    ...traffic,
    totalBytes: traffic.uploadBytes + traffic.downloadBytes,
  };
}
