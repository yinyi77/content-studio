import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Storage {
  constructor(root) { this.root = root; }
  async init() { await mkdir(path.join(this.root, 'projects'), { recursive: true, mode: 0o700 }); }
  dir(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的作品编号');
    return path.join(this.root, 'projects', id);
  }
  async read(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  async atomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }
  config() { return this.read(path.join(this.root, 'config.json'), null); }
  saveConfig(config) { return this.atomic(path.join(this.root, 'config.json'), config); }
  get(id) { return this.read(path.join(this.dir(id), 'project.json'), null); }
  async save(project) {
    project.updatedAt = new Date().toISOString();
    await this.atomic(path.join(this.dir(project.id), 'project.json'), project);
  }
  async list() {
    const names = await readdir(path.join(this.root, 'projects'));
    const projects = await Promise.all(names.filter(x => /^[0-9a-f-]{36}$/.test(x)).map(x => this.get(x)));
    return projects.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  remove(id) { return rm(this.dir(id), { recursive: true, force: true }); }
}

// Small, dependency-free ZIP writer (stored entries, UTF-8 filenames).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zip(files) {
  const chunks = [], central = [];
  let offset = 0, centralLength = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), body = Buffer.from(file.body), crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8); header.writeUInt16LE(0x21, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20); header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name); centralLength += header.length + name.length;
    offset += local.length + name.length + body.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralLength, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
