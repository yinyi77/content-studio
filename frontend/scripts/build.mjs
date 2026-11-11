import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vben recommends ASCII build paths. Keep source in the project and build in a
// stable, isolated temporary workspace; dependency downloads use pnpm's cache.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(os.tmpdir(), 'content-studio-vben-' + createHash('sha256').update(source).digest('hex').slice(0, 12));
function supported(version) { const [major, minor] = version.replace(/^v/, '').split('.').map(Number); return major === 22 && minor >= 18 || major === 24 && minor >= 12 || major > 24; }
async function nodeBinary() {
  if (process.env.VBEN_NODE_BINARY) return process.env.VBEN_NODE_BINARY;
  if (supported(process.version)) return process.execPath;
  const nvm = path.join(os.homedir(), '.nvm/versions/node');
  const versions = await readdir(nvm).catch(() => []);
  const available = versions.filter(supported).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of available) { const candidate = path.join(nvm, version, 'bin/node'); if (existsSync(candidate)) return candidate; }
  throw new Error('Vben 构建需要 Node.js 22.18+ 或 24.12+；可通过 VBEN_NODE_BINARY 指定。已有 dist 的本地服务仍可使用 Node 20。');
}
function run(command, args, env) {
  return new Promise((resolve,reject) => {
    const child = spawn(command, args, { cwd: build, env, stdio: 'inherit' });
    child.on('error', reject);child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Frontend command exited with ${code}`)));
  });
}
const node = await nodeBinary();
const env = { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH };
await mkdir(build, { recursive: true });
for (const dir of ['src','packages','internal','scripts']) {
  await rm(path.join(build,dir),{recursive:true,force:true});
  await cp(path.join(source,dir),path.join(build,dir),{recursive:true,filter:item=>!item.split(path.sep).includes('node_modules')});
}
for (const file of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.ts','tsconfig.json','index.html','.npmrc']) await cp(path.join(source,file),path.join(build,file));
const pkg=JSON.parse(await readFile(path.join(build,'package.json'),'utf8'));
if (!pkg.dependencies?.['@vben/layouts']) throw new Error('Vben workspace metadata missing.');
try { await run(process.env.VBEN_PNPM_BINARY || 'pnpm',['install','--frozen-lockfile','--ignore-scripts'],env); }
catch(error) { if(error.code!=='ENOENT') throw error;await run(path.join(path.dirname(node),'corepack'),['pnpm','install','--frozen-lockfile','--ignore-scripts'],env); }
await run(node,[path.join(build,'node_modules/vite/bin/vite.js'),'build'],env);
await rm(path.join(source,'dist'),{recursive:true,force:true});
await cp(path.join(build,'dist'),path.join(source,'dist'),{recursive:true});
console.log('Vben Admin build ready: frontend/dist');
