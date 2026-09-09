#!/usr/bin/env python3
"""Install on the Moscow entry, adopting its currently selected WireGuard exit.
Run first without --activate-hooks to verify the controller; activation restarts OpenVPN once.
"""
import argparse
import datetime
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--entry-host', required=True)
parser.add_argument('--name', default='Германия')
parser.add_argument('--telegram', action='store_true')
parser.add_argument('--activate-hooks', action='store_true')
args = parser.parse_args()
assert os.geteuid() == 0
assert ipaddress.ip_address(args.entry_host).is_global
source = Path(__file__).resolve().parent
backup = Path('/root/vpnbot-backups') / ('emergency-control-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700, parents=True)
config = Path('/etc/openvpn/server/server-tcp.conf')
for path in [config, Path('/etc/default/vpnbot-routing'), Path('/etc/vpnbot-egress-manager/state.json')]:
    if path.exists(): shutil.copy2(path, backup / path.name)

def run(command, **kw):
    return subprocess.run(command, check=True, capture_output=True, text=True, **kw).stdout.strip()

def install(name, target, mode):
    path=Path(target); path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists(): shutil.copy2(path, backup / (name + '.previous'))
    path.write_text((source/name).read_text())
    os.chmod(path, mode)

for name in ['vpnbot-egress-control','vpnbot-egress-session']:
    install(name, '/usr/local/sbin/' + name, 0o755)
for name in ['vpnbot-egress-manager.service','vpnbot-egress-events.service','vpnbot-egress-map.service','vpnbot-egress-map.timer']:
    install(name, '/etc/systemd/system/' + name, 0o644)

root=Path('/etc/vpnbot-egress-manager'); root.mkdir(mode=0o700, exist_ok=True)
state=root/'state.json'
if not state.exists():
    defaults=dict(re.findall(r'^(VPN_[A-Z_]+)=(.+)$',Path('/etc/default/vpnbot-routing').read_text(),re.M))
    interface=defaults['VPN_EGRESS_INTERFACE'].strip().strip('"')
    assert re.fullmatch(r'[A-Za-z0-9_-]{1,15}', interface)
    peer=str(ipaddress.ip_address(defaults['VPN_EGRESS_PEER'].strip()))
    endpoints=run(['wg','show',interface,'endpoints']).splitlines()
    assert len(endpoints)==1
    host=str(ipaddress.ip_address(endpoints[0].split()[1].rsplit(':',1)[0]))
    addresses=json.loads(run(['ip','-j','-4','address','show','dev',interface]))
    local=addresses[0]['addr_info'][0]['local']
    value={'revision':1,'entryHost':args.entry_host,'default':'e1','proxy':'e1' if args.telegram else None,
           'assignments':{},'nodes':[{'id':'e1','name':args.name,'host':host,'status':'ready','telegram':args.telegram,
           'interface':interface,'peer':peer,'local':local,'table':23001,'stage':'Действующий выход подключён к управлению'}]}
    state.write_text(json.dumps(value,ensure_ascii=False));os.chmod(state,0o600)

policy=Path('/etc/sudoers.d/vpnbot-egress-control')
policy.write_text('Defaults!/usr/local/sbin/vpnbot-egress-control !use_pty, !log_input, !log_output\nvpn-bot ALL=(root) NOPASSWD: /usr/local/sbin/vpnbot-egress-control ""\n')
os.chmod(policy,0o440)
run(['visudo','-cf',str(policy)])
run(['systemctl','daemon-reload'])
run(['systemctl','enable','--now','vpnbot-egress-manager.service','vpnbot-egress-events.service','vpnbot-egress-map.timer'])
for attempt in range(50):
    if Path('/run/vpnbot-egress-manager/session.sock').is_socket(): break
    time.sleep(0.1)
else: raise RuntimeError('OpenVPN event socket did not start')
result=json.loads(run(['/usr/local/sbin/vpnbot-egress-control'],input=json.dumps({'action':'check','id':'e1'})))
assert result['ok'], result.get('error')

if args.activate_hooks:
    # Preserve and chain the existing accounting hook, including its arguments.
    previous=Path('/etc/openvpn/vpnbot-egress-original-hooks.json')
    if not previous.exists():
        hooks={}
        for line in config.read_text().splitlines():
            words=shlex.split(line,comments=True)
            if words and words[0] in ('client-connect','client-disconnect'): hooks[words[0]]=words[1:]
        previous.write_text(json.dumps(hooks));os.chmod(previous,0o644)
    wrapper=Path('/usr/local/sbin/vpnbot-egress-hook')
    wrapper.write_text('''#!/usr/bin/env python3
import json,os,subprocess,sys
hooks=json.load(open('/etc/openvpn/vpnbot-egress-original-hooks.json'))
original=hooks.get(os.environ.get('script_type',''))
if original:
    code=subprocess.call(original+sys.argv[1:])
    if code: sys.exit(code)
sys.exit(subprocess.call(['/usr/local/sbin/vpnbot-egress-session']))
''')
    os.chmod(wrapper,0o755)
    text=config.read_text()
    lines=[line for line in text.splitlines() if not re.match(r'^\s*client-(connect|disconnect)\s',line)]
    updated='\n'.join(lines)+'\nclient-connect /usr/local/sbin/vpnbot-egress-hook\nclient-disconnect /usr/local/sbin/vpnbot-egress-hook\n'
    dependency=Path('/etc/systemd/system/openvpn-server@server-tcp.service.d/egress.conf')
    dependency.parent.mkdir(parents=True,exist_ok=True)
    dependency.write_text('[Unit]\nRequires=vpnbot-egress-events.service\nAfter=vpnbot-egress-events.service\n')
    os.chmod(dependency,0o644)
    run(['systemctl','daemon-reload'])
    if text != updated:
        config.write_text(updated)
        try: run(['systemctl','restart','openvpn-server@server-tcp'])
        except Exception:
            config.write_text(text);run(['systemctl','restart','openvpn-server@server-tcp']);raise
print(json.dumps({'ok':True,'backup':str(backup),'hooksActivated':args.activate_hooks}))
