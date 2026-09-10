import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { VpnConfigRecord } from "./domain.js";
import type { ServerManager } from "./server-manager.js";
import { runSshCommand } from "./ssh-run.js";
import { isExpired } from "./time.js";

export interface EgressNode {
  id: string; name: string; host: string; status: "provisioning" | "ready" | "error";
  telegram: boolean; error?: string; stage?: string;
}
export interface EgressSnapshot {
  revision: number; default: string; proxy: string | null;
  nodes: EgressNode[]; assignments: Record<string, string>;
}
export interface EgressCredentials { name: string; host: string; port: number; username: string; password: string; }
export function parseEgressCredentials(text: string): EgressCredentials {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (![4, 5].includes(lines.length)) throw new Error("Отправьте четыре строки: IPv4, SSH-порт, пароль root, название сервера.");
  const fields = lines.length === 4 ? [lines[3], lines[0], lines[1], "root", lines[2]] : lines;
  const [name = "", host = "", portText = "", username = "", password = ""] = fields;
  if (!name.trim() || name.trim().length > 40 || /[\x00-\x1f]/.test(name)) throw new Error("Название: от 1 до 40 символов.");
  const octets = host.trim().split(".");
  if (octets.length !== 4 || octets.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) throw new Error("Укажите IPv4 нового VPS.");
  const port = Number(portText.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Некорректный SSH-порт.");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username.trim())) throw new Error("Некорректный SSH-логин.");
  if (!password || password.length > 512 || /[\x00\r\n]/.test(password)) throw new Error("Некорректный пароль.");
  return { name: name.trim(), host: host.trim(), port, username: username.trim(), password };
}

export class EgressService {
  constructor(private readonly db: AppDatabase, private readonly servers: ServerManager,
    readonly entryKey: string,
    private readonly execute: typeof runSshCommand = runSshCommand) {}

  manages(config: VpnConfigRecord): boolean { return config.serverKey === this.entryKey; }
  private async call<T>(request: Record<string, unknown>): Promise<T> {
    const target = await this.servers.resolveTarget(this.entryKey);
    if (!target) throw new Error("Московская точка управления недоступна.");
    try {
      const output = await this.execute({ host: target.host, port: target.port, username: target.username,
        privateKey: target.privateKey, hostFingerprint: target.hostFingerprint,
        command: "sudo -n /usr/local/sbin/vpnbot-egress-control", proxyUrl: undefined,
        input: Buffer.from(JSON.stringify(request)), timeoutMs: 90_000 });
      const result = JSON.parse(output.toString()) as { ok: boolean; data: T; error?: string };
      if (!result.ok) throw new EgressError(result.error ?? "Операция не выполнена.");
      return result.data;
    } catch (error) {
      if (error instanceof EgressError) throw error;
      // Never forward SSH output: provisioning requests contain a one-time password.
      throw new Error("Не удалось получить ответ Москвы. Обновите статус перед повторной операцией.");
    }
  }
  snapshot(): Promise<EgressSnapshot> { return this.call({ action: "status" }); }
  async configExit(config: VpnConfigRecord, snapshot?: EgressSnapshot): Promise<string> {
    const state = snapshot ?? await this.snapshot();
    return state.assignments[config.clientName] ?? state.default;
  }
  async add(credentials: EgressCredentials, telegram: boolean): Promise<{ id: string }> {
    return this.call({ action: "add", ...credentials, telegram, requestId: randomUUID() });
  }
  check(id: string): Promise<{ healthy: boolean; message: string }> { return this.call({ action: "check", id }); }
  async move(source: string, target: string, revision: number, telegram: boolean): Promise<{ moved: number }> {
    const configs = (await this.db.listActiveConfigs()).filter(c => this.manages(c));
    return this.call({ action: "move", source, target, revision, telegram,
      clients: configs.map(c => c.clientName), requestId: randomUUID() });
  }
  async assign(config: VpnConfigRecord, target: string, revision: number): Promise<void> {
    if (!this.manages(config) || config.status !== "active" || isExpired(config.expiresAt)) throw new Error("Конфиг недоступен для смены выхода.");
    await this.call({ action: "assign", client: config.clientName, target, revision, requestId: randomUUID() });
  }
  async setProxy(target: string, revision: number): Promise<void> {
    await this.call({ action: "proxy", target, revision, requestId: randomUUID() });
  }
}
class EgressError extends Error {}
