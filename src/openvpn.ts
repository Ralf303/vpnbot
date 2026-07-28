import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { ServerKey, ServerTraffic } from "./domain.js";
import type { VpnServerConfig } from "./config.js";

const CLIENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function verifyClientName(name: string): void {
  if (!CLIENT_NAME.test(name))
    throw new Error("Недопустимое техническое имя OpenVPN-клиента");
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export class OpenVpnGateway {
  constructor(
    private readonly servers: Partial<Record<ServerKey, VpnServerConfig>>
  ) {}

  isConfigured(serverKey: ServerKey): boolean {
    return Boolean(this.servers[serverKey]);
  }

  serverName(serverKey: ServerKey): string {
    return (
      this.servers[serverKey]?.name ??
      (serverKey === "new" ? "Новый сервер" : "Старый сервер")
    );
  }

  async createClient(
    serverKey: ServerKey,
    clientName: string
  ): Promise<Buffer> {
    verifyClientName(clientName);
    return this.execute(serverKey, ["create", clientName]);
  }

  async downloadClient(
    serverKey: ServerKey,
    clientName: string
  ): Promise<Buffer> {
    verifyClientName(clientName);
    return this.execute(serverKey, ["download", clientName]);
  }

  async revokeClient(serverKey: ServerKey, clientName: string): Promise<void> {
    verifyClientName(clientName);
    await this.execute(serverKey, ["revoke", clientName]);
  }

  async listClients(serverKey: ServerKey): Promise<string[]> {
    const output = await this.execute(serverKey, ["list"]);
    return output
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async traffic(serverKey: ServerKey): Promise<ServerTraffic> {
    const output = await this.execute(serverKey, ["stats"]);
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

  private async execute(serverKey: ServerKey, args: string[]): Promise<Buffer> {
    const server = this.servers[serverKey];
    if (!server)
      throw new Error(`${this.serverName(serverKey)} пока не настроен`);
    const command = [server.helperCommand, ...args].join(" ");

    return new Promise<Buffer>((resolve, reject) => {
      const connection = new Client();
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          connection.end();
          reject(new Error(`Тайм-аут подключения к серверу «${server.name}»`));
        }
      }, 30_000);

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        connection.end();
        callback();
      };

      connection.on("ready", () => {
        connection.exec(command, (error, stream) => {
          if (error) {
            finish(() => reject(error));
            return;
          }

          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
          stream.stderr.on("data", (chunk: Buffer) =>
            stderr.push(Buffer.from(chunk))
          );
          stream.on("close", (code: number | undefined) => {
            const errorText = Buffer.concat(stderr).toString("utf8").trim();
            if (code === 0) {
              finish(() => resolve(Buffer.concat(stdout)));
            } else {
              finish(() =>
                reject(
                  new Error(
                    errorText || `VPN helper завершился с кодом ${code ?? "?"}`
                  )
                )
              );
            }
          });
        });
      });
      connection.on("error", (error) => finish(() => reject(error)));
      connection.connect({
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey: server.privateKey,
        readyTimeout: 20_000,
        keepaliveInterval: 5_000,
        hostVerifier: (key: Buffer) =>
          fingerprint(key) === server.hostFingerprint,
      });
    });
  }
}
