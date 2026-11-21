// 统一配置加载：环境变量 > <repo>/config.json > 默认值
// config.json 不入库（见 .gitignore），install.sh 会生成模板
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fileCfg = {};
try {
  fileCfg = JSON.parse(await readFile(path.join(__dirname, 'config.json'), 'utf8'));
} catch { /* 无配置文件时用默认/环境变量 */ }

export const HOME = os.homedir();
export const ROOT = __dirname;
export const DATA_DIR = path.join(HOME, '.agent-manager'); // 运行时数据统一放这里

export const config = {
  port: Number(process.env.PORT || fileCfg.port || 3100),
  hubUrl: (process.env.MCPHUB_URL || fileCfg.hubUrl || 'http://localhost:3000').replace(/\/$/, ''),
  hubKey: process.env.MCPHUB_KEY || fileCfg.hubKey || '',
  asmBin: process.env.ASM_BIN || fileCfg.asmBin || `${HOME}/.npm-global/bin/asm`,
  // MCPHub dashboard 账号（仅用于前端展示提示，不参与认证）
  hubDashboard: fileCfg.hubDashboard || { user: 'admin' },
  agentManagerUrl: process.env.AGENT_MANAGER_URL || fileCfg.agentManagerUrl || `http://localhost:${Number(process.env.PORT || fileCfg.port || 3100)}`,
  // MCPHub 数据目录（mcp_settings.json / wb-headers.json / 日志所在），默认 ~/mcphub
  hubDataDir: process.env.MCPHUB_DATA_DIR || fileCfg.hubDataDir || `${HOME}/mcphub`,
};
