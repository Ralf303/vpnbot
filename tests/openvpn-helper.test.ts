import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let fixtureRoot: string | undefined;

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe.skipIf(process.platform === "win32")("openvpn-bot-helper", () => {
  async function cleanupFixture() {
    fixtureRoot = await mkdtemp(join(tmpdir(), "vpnbot-cleanup-"));
    const root = fixtureRoot;
    const server = join(root, "etc/openvpn/server");
    const relay = join(root, "etc/vpnbot-relay");
    const unit = join(root, "etc/systemd/system/vpnbot-relay-tunnel.service");
    for (const folder of [server, relay, join(root, "etc/systemd/system"), join(root, "bin")]) await mkdir(folder, { recursive: true });
    await writeFile(unit, "Description=VPN bot reverse relay tunnel\nRequires=openvpn-server@server.service\n");
    await writeFile(join(relay, "server-key"), "srv_2\n");
    await writeFile(join(server, "server.conf"), "local 127.0.0.1\nport 1194\nproto tcp\n");
    await mkdir(join(server, "easy-rsa/pki"), { recursive: true });
    await writeFile(join(server, "easy-rsa/pki/private-key"), "secret");
    const calls = join(root, "systemctl-calls");
    await writeFile(join(root, "bin/systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o700 });
    const source = (await readFile(resolve("deploy/openvpn-bot-helper"), "utf8"))
      .replaceAll("/etc/", `${root}/etc/`).replaceAll("/usr/local/sbin/", `${root}/usr/local/sbin/`)
      .replaceAll("/var/lib/openvpn-bot/", `${root}/var/lib/openvpn-bot/`)
      .replace('LOCK_FILE="/run/lock/openvpn-bot-helper.lock"', `LOCK_FILE="${root}/helper.lock"`);
    const helper = join(root, "helper");
    await writeFile(helper, source);
    const run = (key = "srv_2") => execFileAsync("bash", [helper, "cleanup", key], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } });
    return { root, server, relay, calls, run };
  }

  it("cleans only the owned VPN and stops services before removing keys", async () => {
    const f = await cleanupFixture();
    const unrelated = join(f.root, "etc/unrelated-app");
    await writeFile(unrelated, "keep");
    expect((await f.run()).stdout.trim()).toBe("VPNBOT_CLEANUP_OK");
    expect(await readFile(f.calls, "utf8")).toBe("disable --now vpnbot-relay-tunnel.service\ndisable --now openvpn-server@server.service\ndaemon-reload\n");
    await expect(access(join(f.server, "easy-rsa"))).rejects.toThrow();
    await expect(access(f.relay)).rejects.toThrow();
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  });

  it("refuses wrong ownership and shared PKI before stopping anything", async () => {
    const f = await cleanupFixture();
    await expect(f.run("srv_3")).rejects.toThrow("Ключ сервера не совпадает");
    await writeFile(join(f.server, "other.conf"), "keep");
    await expect(f.run()).rejects.toThrow("другой OpenVPN");
    await expect(access(f.calls)).rejects.toThrow();
    expect(await readFile(join(f.server, "easy-rsa/pki/private-key"), "utf8")).toBe("secret");
  });

  it("supports the exact old bootstrap layout but refuses an unowned installation", async () => {
    const f = await cleanupFixture();
    await rm(join(f.relay, "server-key"));
    await writeFile(join(f.server, "server.conf"), "port 443\nproto tcp\n");
    await expect(f.run()).rejects.toThrow("установка ботом");
    await expect(access(f.calls)).rejects.toThrow();
    await writeFile(join(f.server, "server.conf"), "local 127.0.0.1\nport 1194\nproto tcp\n");
    expect((await f.run()).stdout.trim()).toBe("VPNBOT_CLEANUP_OK");
  });

  it("reads active sessions from a named server-status-<instance>.tsv", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "vpnbot-helper-"));
    const openVpnDir = join(fixtureRoot, "openvpn", "server");
    const easyRsaDir = join(openVpnDir, "easy-rsa");
    const pkiDir = join(easyRsaDir, "pki");
    const statusDir = join(fixtureRoot, "run", "openvpn-server");
    await mkdir(pkiDir, { recursive: true });
    await mkdir(statusDir, { recursive: true });
    await writeFile(join(easyRsaDir, "easyrsa"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(join(openVpnDir, "client-common.txt"), "client\n");
    await writeFile(join(pkiDir, "index.txt"), "");

    const helperSource = await readFile(
      resolve("deploy/openvpn-bot-helper"),
      "utf8"
    );
    const helperPath = join(fixtureRoot, "openvpn-bot-helper");
    const fixtureHelper = helperSource
      .replace('OPENVPN_DIR="/etc/openvpn/server"', `OPENVPN_DIR="${openVpnDir}"`)
      .replace(
        'LOCK_FILE="/run/lock/openvpn-bot-helper.lock"',
        `LOCK_FILE="${join(fixtureRoot, "helper.lock")}"`
      )
      .replace(
        'TRAFFIC_EVENTS_DIR="/var/lib/openvpn-bot/traffic-events"',
        `TRAFFIC_EVENTS_DIR="${join(fixtureRoot, "traffic-events")}"`
      )
      .replaceAll("/run/openvpn-server/", `${statusDir}/`)
      .replaceAll("/run/openvpn/status", `${fixtureRoot}/missing-run-status`)
      .replaceAll("/var/log/openvpn/status", `${fixtureRoot}/missing-var-status`);
    await writeFile(helperPath, fixtureHelper, { mode: 0o700 });

    await writeFile(
      join(statusDir, "server-status-tcp.tsv"),
      [
        "HEADER\tCLIENT_LIST\tCommon Name\tReal Address\tVirtual Address\tVirtual IPv6 Address\tBytes Received\tBytes Sent\tConnected Since\tConnected Since (time_t)\tUsername\tClient ID\tPeer ID\tData Channel Cipher",
        "CLIENT_LIST\ttestclient\t198.51.100.1:1234\t10.8.0.2\t\t123\t456\tnow\t1700000000\tUNDEF\t1\t1\tAES-256-GCM",
        "END",
      ].join("\n")
    );

    const { stdout } = await execFileAsync("bash", [helperPath, "active-sessions"]);
    expect(stdout.trim()).toBe("active\ttestclient\t1700000000\t123\t456");
  });
});
