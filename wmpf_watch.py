# -*- coding: utf-8 -*-
"""WeChatAppEx 注入器（便携版）：纯 ctypes 找进程，不依赖 PowerShell。"""
import sys, os, json, time, re, ctypes
from ctypes import wintypes
from collections import Counter

ROOT = os.path.dirname(os.path.abspath(__file__))
_RT = os.path.join(ROOT, "runtime", "python")
if os.path.isdir(_RT) and _RT not in sys.path:
    sys.path.insert(0, _RT)

import frida

HOOK = os.path.join(ROOT, "frida", "hook.js")
AUTODETECT = os.path.join(ROOT, "frida", "autodetect", "win32.js")
CONFIGDIR = os.path.join(ROOT, "frida", "config", "win32")

TH32CS_SNAPPROCESS = 0x00000002


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ('dwSize', wintypes.DWORD),
        ('cntUsage', wintypes.DWORD),
        ('th32ProcessID', wintypes.DWORD),
        ('th32DefaultHeapID', ctypes.POINTER(ctypes.c_ulong)),
        ('th32ModuleID', wintypes.DWORD),
        ('cntThreads', wintypes.DWORD),
        ('th32ParentProcessID', wintypes.DWORD),
        ('pcPriClassBase', ctypes.c_long),
        ('dwFlags', wintypes.DWORD),
        ('szExeFile', ctypes.c_wchar * 260),
    ]


def log(*a):
    print(*a, flush=True)


def enum_procs():
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    out = []
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        out.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return out


def find_main_pid():
    """主进程 = WeChatAppEx 家族里被最多子进程指向的父进程。"""
    procs = enum_procs()
    mine = [(pid, ppid) for (pid, ppid, name) in procs if name.lower() == 'wechatappex.exe']
    if not mine:
        return 0
    pids = set(p for p, _ in mine)
    # 主进程 = 被最多『同类子进程』指向的那个父进程
    c = Counter(ppid for _, ppid in mine if ppid in pids)
    if c:
        return c.most_common(1)[0][0]
    # 没有子进程时：主进程通常是第一个（或被 Weixin 拉起的那个）
    parents = {ppid for _, ppid in mine}
    for pid, ppid in mine:
        if pid not in parents:
            return pid
    return mine[0][0]


def detect_version():
    """WMPF 版本 = RadiumWMPF 下最近被写入的那个版本目录（微信启动时用的就是它）。"""
    base = os.path.join(os.environ.get('APPDATA', ''), 'Tencent', 'xwechat', 'xplugin', 'plugins', 'RadiumWMPF')
    best, best_t = 0, 0
    try:
        for name in os.listdir(base):
            p = os.path.join(base, name)
            if not (name.isdigit() and os.path.isdir(p)):
                continue
            exe = os.path.join(p, 'extracted', 'runtime', 'WeChatAppEx.exe')
            t = os.path.getmtime(exe if os.path.exists(exe) else p)
            if t > best_t:
                best_t, best = t, int(name)
    except Exception as e:
        log('[!] 识别版本失败:', e)
    return best


def load_config(ver, session):
    cached = os.path.join(CONFIGDIR, "addresses.%s.json" % ver)
    if os.path.exists(cached):
        return json.load(open(cached, 'r', encoding='utf-8'))
    log('[*] 没有 %s 的偏移缓存，正在自动探测（第一次会慢十几秒）...' % ver)
    src = open(AUTODETECT, 'r', encoding='utf-8').read()
    script = session.create_script(src)
    state = {'done': False}

    def on_msg(message, data):
        if message.get('type') == 'error':
            state['error'] = message.get('description')
            state['done'] = True
            return
        payload = message.get('payload') or {}
        if payload.get('type') == 'wmpf-offsets':
            state['config'] = payload['config']
            state['done'] = True
        elif payload.get('type') == 'wmpf-offsets-error':
            state['error'] = payload.get('error')
            state['done'] = True

    script.on('message', on_msg)
    script.load()
    t0 = time.time()
    while not state['done'] and time.time() - t0 < 180:
        time.sleep(0.3)
    try:
        script.unload()
    except Exception:
        pass
    if state.get('error'):
        raise RuntimeError(state['error'])
    cfg = state['config']
    cfg['Version'] = ver
    os.makedirs(CONFIGDIR, exist_ok=True)
    json.dump(cfg, open(cached, 'w', encoding='utf-8'), indent=4)
    return cfg


def attach(pid):
    device = frida.get_local_device()
    session = device.attach(pid)
    ver = detect_version()
    if not ver:
        raise RuntimeError('没能从 flue.dll 路径识别 WMPF 版本')
    cfg = load_config(ver, session)
    hook_src = open(HOOK, 'r', encoding='utf-8').read().replace('@@CONFIG@@', json.dumps(cfg))
    hook = session.create_script(hook_src)

    def on_hook(m, d):
        if m.get('type') == 'error':
            log('[frida][ERROR]', m.get('description'))
        else:
            log('[frida]', m.get('payload'))

    hook.on('message', on_hook)
    hook.load()
    return session, ver


def main():
    log('[*] 等待微信小程序进程（在微信里打开「扫码签到」即可）')
    cur = 0
    session = None
    fails = 0
    while True:
        try:
            pid = find_main_pid()
        except Exception:
            pid = 0
        if pid and pid != cur:
            try:
                if session is not None:
                    try:
                        session.detach()
                    except Exception:
                        pass
                    session = None
                session, ver = attach(pid)
                cur = pid
                fails = 0
                log('[*] 已挂上 pid=%d  WMPF=%s —— 现在打开 / 重新打开小程序' % (pid, ver))
            except Exception as e:
                fails += 1
                log('[!] 注入失败(%d): %s' % (fails, e))
                cur = 0
                time.sleep(2)
                continue
        elif not pid and cur:
            log('[*] 小程序进程已退出，等待重新打开...')
            cur = 0
            session = None
        time.sleep(1.5)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass