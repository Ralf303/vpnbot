import type {
  ActiveTrafficSession,
  CompletedTrafficSession,
  ServerKey,
  ServerTraffic,
  TrafficSnapshot,
} from "./domain.js";
import type { VpnServerConfig } from "./config.js";
import { runSshCommand } from "./ssh-run.js";

const CLIENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TRAFFIC_CLIENT_NAME = /^[A-Za-z0-9_.@-]{1,64}$/;

function verifyClientName(name: string): void {
  if (!CLIENT_NAME.test(name))
    throw new Error("Недопустимое техническое имя OpenVPN-клиента");
}

export interface VpnServerTarget {
  key: ServerKey;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKey: string | Buffer;
  hostFingerprint: string;
  helperCommand: string;
  proxyUrl: string | undefined;
  relay?: { host: string; port: number };
}

export class OpenVpnGateway {
  constructor(
    private readonly envServers: Partial<Record<"new" | "old", VpnServerConfig>>,
    private readonly fallbackName: (serverKey: ServerKey) => string
  ) {}

  isConfigured(serverKey: ServerKey): boolean {
    return serverKey in this.envServers;
  }

  isBuiltin(serverKey: ServerKey): boolean {
    return serverKey === "new" || serverKey === "old";
  }

  serverName(serverKey: ServerKey): string {
    return this.envServers[serverKey as "new" | "old"]?.name
      ?? this.fallbackName(serverKey);
  }

  envTarget(serverKey: ServerKey): VpnServerTarget | undefined {
    return this.envServers[serverKey as "new" | "old"];
  }

  async createClient(server: VpnServerTarget, clientName: string): Promise<Buffer> {
    verifyClientName(clientName);
    return this.execute(server, ["create", clientName]);
  }

  async downloadClient(server: VpnServerTarget, clientName: string): Promise<Buffer> {
    verifyClientName(clientName);
    return this.execute(server, ["download", clientName]);
  }

  async revokeClient(server: VpnServerTarget, clientName: string): Promise<void> {
    verifyClientName(clientName);
    await this.execute(server, ["revoke", clientName]);
  }

  async listClients(server: VpnServerTarget): Promise<string[]> {
    const output = await this.execute(server, ["list"]);
    return output
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async traffic(server: VpnServerTarget): Promise<ServerTraffic> {
    const output = await this.execute(server, ["stats"]);
    const parsed = JSON.parse(
      output.toString("utf8")
    ) as Partial<ServerTraffic>;
    if (
      !Number.isFinite(parsed.uploadBytes) ||
      !Number.isFinite(parsed.downloadBytes)
    ) {
      throw new Error("VPN helper вернул некорректную статистику");
    }
    return {
      uploadBytes: parsed.uploadBytes!,
      downloadBytes: parsed.downloadBytes!,
    };
  }

  async trafficSessions(server: VpnServerTarget): Promise<TrafficSnapshot> {
    const output = await this.execute(server, ["traffic-sessions"]);
    const snapshot = parseTrafficSnapshot(output);
    const batchIds = output.toString("utf8").split(/\r?\n/)
      .filter((line) => line.startsWith("batch\t"))
      .map((line) => line.slice(6));
    if (batchIds.length !== snapshot.completed.length ||
        batchIds.some((id, index) => snapshot.completed[index]?.eventId !== id))
      throw new Error("Некорректная порция событий трафика; файлы сохранены для проверки");
    return { ...snapshot, batchIds };
  }

  async acknowledgeTrafficEvents(server: VpnServerTarget, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    if (eventIds.length > 1000 || eventIds.some((id) => !/^[A-Za-z0-9_.@-]{1,160}$/.test(id)))
      throw new Error("Некорректные ID событий трафика");
    await runSshCommand({
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: server.privateKey,
      hostFingerprint: server.hostFingerprint,
      command: `${server.helperCommand} traffic-ack`,
      input: Buffer.from(`${eventIds.join("\n")}\n`),
      proxyUrl: server.proxyUrl,
      timeoutMs: 30_000,
    });
  }

  async activeSessions(server: VpnServerTarget): Promise<ActiveTrafficSession[]> {
    const output = await this.execute(server, ["active-sessions"]);
    return parseTrafficSnapshot(output).active;
  }

  async stopManagedRelay(server: VpnServerTarget): Promise<void> {
    await runSshCommand({
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: server.privateKey,
      hostFingerprint: server.hostFingerprint,
      command: "sudo /usr/bin/systemctl disable --now vpnbot-relay-tunnel.service",
      proxyUrl: server.proxyUrl,
      timeoutMs: 30_000,
    });
  }

  async cleanupManagedServer(server: VpnServerTarget): Promise<void> {
    if (!/^srv_[1-9][0-9]*$/.test(server.key))
      throw new Error("Очистка доступна только для серверов, добавленных ботом.");
    const result = await this.execute(server, ["cleanup", server.key]);
    if (result.toString("utf8").trim() !== "VPNBOT_CLEANUP_OK")
      throw new Error("VPS не подтвердил очистку. Запись сервера сохранена.");
  }

  private async execute(server: VpnServerTarget, args: string[]): Promise<Buffer> {
    const command = [server.helperCommand, ...args].join(" ");
    return runSshCommand({
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: server.privateKey,
      hostFingerprint: server.hostFingerprint,
      command,
      proxyUrl: server.proxyUrl,
      timeoutMs: 30_000,
    });
  }
}

function parseTrafficSnapshot(output: Buffer): TrafficSnapshot {
  const active: ActiveTrafficSession[] = [];
  const completed: CompletedTrafficSession[] = [];
  for (const line of output.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields[0] === "active" && fields.length === 5) {
      const [, clientName, connectedAt, uploadBytes, downloadBytes] = fields;
      if (!clientName || !TRAFFIC_CLIENT_NAME.test(clientName)) continue;
      const parsed = parseTrafficNumbers(
        connectedAt,
        uploadBytes,
        downloadBytes
      );
      if (!parsed) continue;
      active.push({ clientName, ...parsed });
    } else if (fields[0] === "completed" && fields.length === 7) {
      const [
        ,
        eventId,
        clientName,
        connectedAt,
        disconnectedAt,
        uploadBytes,
        downloadBytes,
      ] = fields;
      if (
        !eventId ||
        eventId.length > 160 ||
        !clientName ||
        !TRAFFIC_CLIENT_NAME.test(clientName)
      )
        continue;
      const parsed = parseTrafficNumbers(
        connectedAt,
        uploadBytes,
        downloadBytes
      );
      const disconnected = Number(disconnectedAt);
      if (
        !parsed ||
        !Number.isSafeInteger(disconnected) ||
        disconnected < parsed.connectedAt
      )
        continue;
      completed.push({
        eventId,
        clientName,
        ...parsed,
        disconnectedAt: disconnected,
      });
    }
  }
  return { active, completed };
}

function parseTrafficNumbers(
  connectedAt: string | undefined,
  uploadBytes: string | undefined,
  downloadBytes: string | undefined
): Pick<ActiveTrafficSession, "connectedAt" | "uploadBytes" | "downloadBytes"> | null {
  const connected = Number(connectedAt);
  const upload = Number(uploadBytes);
  const download = Number(downloadBytes);
  if (
    !Number.isSafeInteger(connected) ||
    connected < 0 ||
    !Number.isSafeInteger(upload) ||
    upload < 0 ||
    !Number.isSafeInteger(download) ||
    download < 0
  ) return null;
  return { connectedAt: connected, uploadBytes: upload, downloadBytes: download };
}
