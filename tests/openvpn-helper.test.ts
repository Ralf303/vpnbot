import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
