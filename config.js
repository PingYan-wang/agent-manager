// 统一配置加载：环境变量 > <repo>/config.json > 默认值
// config.json 不入库（见 .gitignore），install.sh 会生成模板
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fileCfg = {};
const configPath = process.env.AGENT_MANAGER_CONFIG || path.join(__dirname, 'config.json');
try {
  fileCfg = JSON.parse(await readFile(configPath, 'utf8'));
  if (!fileCfg || typeof fileCfg !== 'object' || Array.isArray(fileCfg)) throw new Error('配置必须为 JSON 对象');
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`无法加载配置 ${configPath}: ${error.message}`);
  if (process.env.AGENT_MANAGER_CONFIG) throw new Error(`指定的配置文件不存在: ${configPath}`);
}

export const HOME = os.homedir();
export const ROOT = __dirname;
export const DATA_DIR = path.resolve(process.env.AGENT_MANAGER_DATA_DIR || fileCfg.dataDir || path.join(HOME, '.agent-manager'));

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须为 1–65535 的整数');
  return port;
}
function httpUrl(value, name) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${name} 必须为不含登录信息的 HTTP(S) 地址`);
  return url.toString().replace(/\/$/, '');
}
const port = validPort(process.env.PORT || fileCfg.port || 3100);

export const config = {
  port,
  hubUrl: httpUrl(process.env.MCPHUB_URL || fileCfg.hubUrl || 'http://localhost:3000', 'hubUrl'),
  hubKey: process.env.MCPHUB_KEY || fileCfg.hubKey || '',
  asmBin: process.env.ASM_BIN || fileCfg.asmBin || `${HOME}/.npm-global/bin/asm`,
  // MCPHub dashboard 账号（仅用于前端展示提示，不参与认证）
  hubDashboard: fileCfg.hubDashboard || { user: 'admin' },
  agentManagerUrl: httpUrl(process.env.AGENT_MANAGER_URL || fileCfg.agentManagerUrl || `http://localhost:${port}`, 'agentManagerUrl'),
  // 隔离验证与首次启动可禁用后台同步；已有安装保持显式配置。
  startupEffects: process.env.AGENT_MANAGER_STARTUP_EFFECTS !== '0' && fileCfg.startupEffects !== false,
  writeToken: process.env.AGENT_MANAGER_WRITE_TOKEN || fileCfg.writeToken || '',
  proxyAllowedOrigins: Array.isArray(fileCfg.proxyAllowedOrigins) ? fileCfg.proxyAllowedOrigins : [],
  // MCPHub 数据目录（mcp_settings.json / wb-headers.json / 日志所在），默认 ~/mcphub
  hubDataDir: process.env.MCPHUB_DATA_DIR || fileCfg.hubDataDir || `${HOME}/mcphub`,
};
