import type { Locale } from "./ipc/contract";

/**
 * 国际化字典。所有 UI 文案集中在此，按 key 索引。
 * 新增文案只需在两个语言对象里各加一行。
 */
export const en = {
  // topbar / branding
  brand: "OpsPilot",
  brandSub: "AI MobaX",
  multiExec: "Multi-exec",
  multiExecOn: "on",
  multiExecOff: "off",
  settings: "Settings",

  // view switcher
  viewTerminals: "Terminals",
  viewSftp: "SFTP",
  viewTunnels: "Tunnels",
  viewMacros: "Macros",
  viewNetwork: "Network",
  viewHistory: "History",

  // sidebar
  connections: "Connections",
  addHost: "+ Host",

  // terminal
  selectHostToOpen: "Select a host on the left to open a terminal",
  searchScrollback: "Ctrl+Shift+F to search scrollback",

  // AI panel
  aiCopilot: "AI Copilot",
  newSession: "+ Session",
  askCopilot:
    "Ask the copilot… e.g. 'check disk space', 'ping 10.0.0.11', 'port scan web-01'",
  send: "Send",
  connectedNative: "connected to native shell",
  browserPreview: "browser preview (mock backend)",

  // SFTP
  sftpHost: "Host",
  go: "Go",
  up: "↑ Up",
  emptyDir: "empty directory",
  download: "↓",
  delete: "×",
  queuedDownload: "queued ↓",
  deleteConfirm: (path: string) => `Delete ${path}?`,
  mockFsNote: "mock filesystem — connect to a real host with the Tauri build",

  // Tunnels
  sshTunnels: "SSH Tunnels",
  tunnelHint: "local (L) · remote (R) · dynamic SOCKS (D)",
  addTunnel: "+ Tunnel",
  noTunnels: "No tunnels. Click \u201c+ Tunnel\u201d.",
  start: "Start",
  stop: "Stop",
  edit: "Edit",
  newTunnel: "New Tunnel",
  editTunnel: "Edit Tunnel",
  tunnelName: "Name",
  tunnelKind: "Kind",
  localL: "Local (L)",
  remoteR: "Remote (R)",
  dynamicD: "Dynamic SOCKS (D)",
  bindAddress: "Bind address",
  localPort: "Local port",
  remoteHostPort: "Remote host:port",
  cancel: "Cancel",
  save: "Save",

  // Macros
  macros: "Macros",
  macroHint: "record keystrokes → replay on any terminal",
  record: "⏺ Record",
  stopRecording: "⏹ Stop recording",
  addMacro: "+ Macro",
  noMacros: "No macros. Record one or add manually.",
  runOnActive: "▶ Run on active",
  newMacro: "New Macro",
  editMacro: "Edit Macro",
  macroSteps: "Steps (one keystroke block per line; \\n is Enter)",
  macroShortcut: "Shortcut (optional, e.g. Ctrl+Shift+1)",

  // Network
  networkTools: "Network Tools",
  networkHint: "also drivable by the AI copilot →",
  run: "Run",
  askAiAboutLast: "↳ Ask AI about last result",
  noNetResults: "Run a tool, or just ask the copilot: \u201cping 10.0.0.11\u201d.",
  ping: "ping",
  portScan: "port scan",
  wakeOnLan: "wake-on-LAN",
  dnsLookup: "DNS lookup",
  traceroute: "traceroute",
  netTargetPlaceholder: "10.0.0.11  ·  web-01  ·  00:11:22:33:44:55",

  // History
  commandHistory: "Command History",
  filter: "filter…",
  clear: "Clear",
  noHistory: "No history yet. Run commands in a terminal.",

  // Settings modal
  settingsTitle: "Settings",
  language: "Language",
  english: "English",
  chinese: "中文",
  engine: "Engine",
  model: "Model",
  baseUrl: "Base URL",
  approvalPolicy: "Approval policy",
  allowDangerous: "Allow dangerous commands after approval",
  approvalTimeout: "Approval timeout (seconds)",
  strictHostKey: "Reject unknown SSH host keys",
  terminalFont: "Terminal font",
  terminalFontSize: "Terminal font size",
  theme: "Theme",
  dshPath: "dsh path (null = auto-detect)",
  maxOutput: "Max output bytes",

  // approval
  approve: "Allow",
  deny: "Deny",
  reason: "reason",

  // status badges
  statusStopped: "stopped",
  statusStarting: "starting",
  statusRunning: "running",
  statusError: "error",
};

export type Dict = typeof en;

export const zh: Dict = {
  brand: "OpsPilot",
  brandSub: "AI MobaX",
  multiExec: "多执行",
  multiExecOn: "开",
  multiExecOff: "关",
  settings: "设置",

  viewTerminals: "终端",
  viewSftp: "文件",
  viewTunnels: "隧道",
  viewMacros: "宏",
  viewNetwork: "网络",
  viewHistory: "历史",

  connections: "连接",
  addHost: "+ 主机",

  selectHostToOpen: "在左侧选择主机以打开终端",
  searchScrollback: "Ctrl+Shift+F 搜索终端历史",

  aiCopilot: "AI 助手",
  newSession: "+ 会话",
  askCopilot: "向助手提问… 例如「查看磁盘空间」「ping 10.0.0.11」「端口扫描 web-01」",
  send: "发送",
  connectedNative: "已连接原生 shell",
  browserPreview: "浏览器预览（mock 后端）",

  sftpHost: "主机",
  go: "前往",
  up: "↑ 上级",
  emptyDir: "空目录",
  download: "↓",
  delete: "×",
  queuedDownload: "已加入下载 ↓",
  deleteConfirm: (path: string) => `删除 ${path}？`,
  mockFsNote: "模拟文件系统 — 使用 Tauri 构建连接真实主机",

  sshTunnels: "SSH 隧道",
  tunnelHint: "本地 (L) · 远程 (R) · 动态 SOCKS (D)",
  addTunnel: "+ 隧道",
  noTunnels: "暂无隧道。点击「+ 隧道」。",
  start: "启动",
  stop: "停止",
  edit: "编辑",
  newTunnel: "新建隧道",
  editTunnel: "编辑隧道",
  tunnelName: "名称",
  tunnelKind: "类型",
  localL: "本地 (L)",
  remoteR: "远程 (R)",
  dynamicD: "动态 SOCKS (D)",
  bindAddress: "绑定地址",
  localPort: "本地端口",
  remoteHostPort: "远程 主机:端口",
  cancel: "取消",
  save: "保存",

  macros: "宏",
  macroHint: "录制按键 → 在任意终端重放",
  record: "⏺ 录制",
  stopRecording: "⏹ 停止录制",
  addMacro: "+ 宏",
  noMacros: "暂无宏。录制一个或手动添加。",
  runOnActive: "▶ 在当前终端运行",
  newMacro: "新建宏",
  editMacro: "编辑宏",
  macroSteps: "步骤（每行一个按键块；\\n 代表回车）",
  macroShortcut: "快捷键（可选，如 Ctrl+Shift+1）",

  networkTools: "网络工具",
  networkHint: "也可由 AI 助手调用 →",
  run: "运行",
  askAiAboutLast: "↳ 让 AI 分析上次结果",
  noNetResults: "运行一个工具，或直接问助手：「ping 10.0.0.11」。",
  ping: "ping",
  portScan: "端口扫描",
  wakeOnLan: "网络唤醒",
  dnsLookup: "DNS 解析",
  traceroute: "路由追踪",
  netTargetPlaceholder: "10.0.0.11  ·  web-01  ·  00:11:22:33:44:55",

  commandHistory: "命令历史",
  filter: "筛选…",
  clear: "清空",
  noHistory: "暂无历史。在终端中运行命令。",

  settingsTitle: "设置",
  language: "语言",
  english: "English",
  chinese: "中文",
  engine: "引擎",
  model: "模型",
  baseUrl: "Base URL",
  approvalPolicy: "审批策略",
  allowDangerous: "允许审批后执行危险命令",
  approvalTimeout: "审批超时（秒）",
  strictHostKey: "拒绝未知 SSH 主机密钥",
  terminalFont: "终端字体",
  terminalFontSize: "终端字号",
  theme: "主题",
  dshPath: "dsh 路径（留空 = 自动检测）",
  maxOutput: "最大输出字节数",

  approve: "允许",
  deny: "拒绝",
  reason: "原因",

  statusStopped: "已停止",
  statusStarting: "启动中",
  statusRunning: "运行中",
  statusError: "错误",
};

const dicts: Record<Locale, Dict> = { en, zh };

let current: Locale = "en";

export function setLocale(loc: Locale) {
  current = loc;
}

export function getLocale(): Locale {
  return current;
}

/** 翻译入口：t("key") 或 t("key", arg)。 */
export function t<K extends keyof Dict>(key: K): string {
  const v = dicts[current][key];
  return typeof v === "string" ? v : String(v);
}

/** 处理带参数的翻译条目（函数型）。 */
export function tf<K extends keyof Dict>(
  key: K,
): Dict[K] extends (a: never) => string ? never : Dict[K] {
  return dicts[current][key] as never;
}
