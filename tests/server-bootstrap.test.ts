import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { renderBootstrapScript, parseBootstrapOutput, formatBootstrapError } from "../src/server-manager.js";

const script = () => renderBootstrapScript("ssh-ed25519 AAAAtest test", {
  host: "entry.example.com", publicHost: "entry.example.com", port: 22, username: "vpn-relay",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
  hostPublicKey: "ssh-ed25519 AAAAtest entry", portStart: 4443, portEnd: 4499,
}, 4443).replaceAll("\\$", "$");

describe("server bootstrap", () => {
  it("reports the failing stage instead of preceding package restart output", () => {
    const message = "Running kernel seems up to date\n".repeat(40)
      + "Host key verification failed.\nVPNBOT_SETUP_ERROR stage=relay_check line=150 code=1";
    expect(formatBootstrapError(new Error(message))).toContain("обратного туннеля");
    expect(formatBootstrapError(new Error(message))).toContain("SSH-ключ relay");
    expect(formatBootstrapError(new Error(message))).not.toContain("Running kernel");
  });

  it("does not echo credentials when the result marker is missing", () => {
    expect(()=>parseBootstrapOutput("secret output")).toThrow("не вернул итоговый результат");
    expect(formatBootstrapError(new Error("prefix\n".repeat(100)+"Connection refused"))).toContain("Connection refused");
  });

  it.skipIf(process.platform === "win32")("renders valid shell and a working error trap", () => {
    execFileSync("bash", ["-n"], {input:script()});
    const prelude=script().split("export DEBIAN_FRONTEND")[0];
    const failed=spawnSync("bash", ["-s"], {input:prelude+"\nVPNBOT_STAGE=openvpn_check\nfalse\n",encoding:"utf8"});
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/VPNBOT_SETUP_ERROR stage=openvpn_check line=\d+ code=1/);
  });

  it.skipIf(process.platform === "win32")("exports one valid OpenSSH key block and preserves keys on retries", () => {
    const folder=mkdtempSync(join(tmpdir(),"vpnbot-key-test-"));
    try {
      const path=join(folder,"key");
      const original=utils.generateKeyPairSync("ed25519").private;
      writeFileSync(path,original,{mode:0o600});
      const emitted=execFileSync("bash",["-s"],{input:`BOT_KEY_PATH='${path}'\n`+script().slice(script().indexOf('echo "===VPNBOT-RESULT===')),env:{...process.env,FP:"SHA256:test"},encoding:"utf8"});
      const parsed=parseBootstrapOutput(emitted);
      expect(parsed.privateKey).toBe(original);
      expect(utils.parseKey(parsed.privateKey)).not.toBeInstanceOf(Error);
      expect(script()).not.toContain('rm -f "$BOT_KEY_PATH"');
      expect(script()).toContain("local 127.0.0.1");
    } finally { rmSync(folder,{recursive:true,force:true}); }
  });
});
