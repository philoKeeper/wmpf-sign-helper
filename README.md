# 微信小程序「位置签到」助手

给 PC 微信里的小程序签到用的：把 `wx.getLocation` 的返回值换成签到点坐标，
让「距离签到点 XXX 米」变成 0。

面向的场景很窄 —— 只有**用经纬度算距离**的那种签到有效。

## 原理

PC 微信的小程序（WMPF，`WeChatAppEx.exe`）内部是一个 Chromium + V8。
它自带一套「局域网调试」通道，但只在特定启动场景下才开。

1. 用 [Frida](https://frida.re/) 附加 `WeChatAppEx.exe` 主进程，hook
   `AppletIndexContainer::OnLoadStart`，把小程序启动时的 scene 改成 1101、
   把 `remoteDebugMode` 置 1、把调试回连地址改成 `ws://localhost:9421`。
2. 本地起一个 WebSocket 服务，把微信私有的 WARemoteDebug(protobuf) 协议
   翻译成标准 Chrome DevTools Protocol。
3. 于是可以用 `Runtime.evaluate` 在小程序**逻辑层**执行 JS，劫持
   `wx.getLocation` / `wx.chooseLocation` 等接口，返回任意坐标。
4. 小程序页面里的 `isInLocation()` 和提交给云函数的坐标，都来自这个接口。

## 环境

- Windows 10/11 x64
- 微信 4.x（本项目在 4.2.0.53 / WMPF 26134 上验证；26516 也验证过）
- Python 3.12 + frida 17
- Node.js 20+

## 快速开始

### 用打包好的版本（推荐给普通用户）

下载 Release 里的 `SignHelper.zip`，解压到**桌面或 D 盘**（不要放在受权限控制的
目录，比如 `Documents` 下，否则注入会被 Windows 拒绝），双击 `start.bat`。

流程：开工具 → 打开小程序进签到页 → 浏览器控制台点「使用签到点坐标」→ 回小程序点签到。

### 从源码跑

```bash
git clone <this repo>
cd wmpf-sign-helper

# 依赖
pnpm i ws protobufjs
pip install frida

# 编译控制台服务
npx tsc src/server.ts --module esnext --moduleResolution node --target es2022 --outDir app
# 产物 app/server.js 改名为 app/server.mjs

# 启动
node app/server.mjs                # CDP 代理 + 网页控制台 :62010
python wmpf_watch.py               # 注入器（常驻，跟随 WeChatAppEx 主进程）
```

然后浏览器打开 http://127.0.0.1:62010 。

`start.bat` 里的路径是按打包结构写的，从源码跑自己改一下。

## 目录

```
start.bat                 双击入口
wmpf_watch.py             常驻注入器（ctypes 找进程 + frida 注入 + 自动探测偏移）
src/server.ts             CDP 代理 + HTTP 控制台的源码
app/server.mjs            上面编译出来的产物
app/third-party/          微信私有调试协议的实现（从微信开发者工具提取）
app/public/index.html     网页控制台
frida/hook.js             注入脚本：改 scene / 开调试模式
frida/autodetect/win32.js 偏移自动探测（扫 .pdata + xref，不需要 IDA）
frida/config/win32/       各 WMPF 版本的偏移缓存
```

## 踩过的坑

**scene 1000 不能碰**：上游注释里写着 `1000: from issue #83 <-- will crash the process`。
无条件改写它会让小程序窗口起不来（逻辑层能连上、页面栈是空数组）。现在直接跳过 1000。

**scene 别的值都可以改**：从聊天卡片打开小程序时 scene 是 1044，不在任何白名单里，
原版 hook 会直接 return —— 这就是「明明注入了却完全不生效」的原因。

**WMPF 版本变了偏移就变**：同一台机器从 26516 升到 26134，三个函数地址全变了
（`0x40c2d40` → `0x2dedc70` 等），但结构体偏移一模一样。
所以升级微信不用改配置，`autodetect` 会现场算。

**主进程判定**：`WeChatAppEx` 主进程的父进程是微信自己的 launcher。
用「父进程不在同类进程集合里」去挑会挑到外层 launcher，attach 上去 hook 永远不触发。
正确做法是「被最多同类子进程指向的那个父进程」。

**路径**：在受 Windows 权限控制的目录（例如 `Documents\\xxx`）下运行，
`OpenProcess` 会返回 err 5，frida 报 `Unable to start idund: Permission denied`。
换个目录就好。

**调试连接会周期性断开**：WMPF 的调试 ws 大概十几秒重连一次。
CDP 请求要排队等连接恢复再发，否则正好撞在断开窗口就全超时。

## 致谢

注入思路和 `frida/hook.js` 的骨架来自 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)
（GPLv2），偏移自动探测脚本也来自该项目。本仓库在原基础上做了：

- 放宽 scene 判断并从崩溃值中排除 1000
- 把注入器改成常驻 watch 模式，跟随主进程 PID 变化
- 用 ctypes 自己做进程枚举，去掉对 PowerShell 的依赖
- 增加 HTTP 网页控制台，把「设坐标」做成一个按钮
- CDP 请求排队，容忍调试连接周期性断开

`app/third-party/` 下的协议实现来自微信开发者工具，版权归腾讯所有。

## 许可

GPLv2，见 [LICENSE](LICENSE)。

## 免责声明

仅供学习研究。用在你自己的签到上后果自负 —— 签到时间、坐标都会入库，管理员看得见。
