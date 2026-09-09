"""Run as root under `unshare --net`; never runs in the host network namespace."""
import importlib.machinery
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types

assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'Run inside unshare --net'
loader = importlib.machinery.SourceFileLoader('control', 'deploy/vpnbot-egress-control')
c = types.ModuleType(loader.name); loader.exec_module(c)
run = c.command
with tempfile.TemporaryDirectory() as folder:
    c.ROOT=Path(folder); c.RUN=c.ROOT/'run'; c.STATE=c.ROOT/'state.json'; c.STATUS=c.ROOT/'status'
    def safe_command(args, **kw):
        if args[0] in ('systemctl','/usr/local/sbin/vpnbot-route-health'): return ''
        return run(args, **kw)
    c.command=safe_command
    original_atomic=c.atomic
    def safe_atomic(path, data, mode=0o600):
        if str(path).startswith('/etc/'): path=c.ROOT/'defaults'
        original_atomic(path,data,mode)
    c.atomic=safe_atomic
    for interface in ['tun1','wga','wgb']:
        run(['ip','link','add',interface,'type','dummy']);run(['ip','link','set',interface,'up'])
    run(['ip','address','add','10.9.0.1/24','dev','tun1'])
    run(['sysctl','-q','-w','net.ipv4.ip_forward=1'])
    state={'revision':1,'default':'e1','proxy':None,'assignments':{'alice':'e2'},'nodes':[
        {'id':'e1','status':'ready','interface':'wga','peer':'10.212.0.2','table':23001},
        {'id':'e2','status':'ready','interface':'wgb','peer':'10.214.2.2','table':23002}]}
    c.save(state)
    c.STATUS.write_text('HEADER\tCLIENT_LIST\tCommon Name\tVirtual Address\nCLIENT_LIST\talice\t10.9.0.5\nCLIENT_LIST\tbob\t10.9.0.8\n')
    c.apply(state)
    assert 'wga' in run(['ip','route','get','1.1.1.1','from','10.9.0.8','iif','tun1','mark','23001'])
    assert 'wgb' in run(['ip','route','get','1.1.1.1','from','10.9.0.5','iif','tun1','mark','23002'])
    nft=run(['nft','list','map','inet','vpnbot_exits','clients'])
    assert '10.9.0.5' in nft and '10.9.0.8' in nft
    c.session({'client':'alice','ip':'10.9.0.9','connected':True})
    nft=run(['nft','list','map','inet','vpnbot_exits','clients'])
    assert '10.9.0.9' in nft and '10.9.0.5' not in nft
    c.session({'client':'alice','ip':'10.9.0.5','connected':False})
    assert '10.9.0.9' in run(['nft','list','map','inet','vpnbot_exits','clients'])
    run(['ip','link','del','wgb'])
    assert subprocess.run(['ip','route','get','1.1.1.1','from','10.9.0.9','iif','tun1','mark','23002'],capture_output=True).returncode != 0
    print('PASS: real nftables maps, per-exit policy rules, reconnect race and blackhole fallback')
