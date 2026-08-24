import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const home = path.resolve(process.env.CLEMENTINE_HOME ?? '.');
const marker = '[cutover-adversarial-guard]';

function refuse(kind, detail = '') {
  const message = `${marker} ${kind}${detail ? ` ${detail}` : ''}`;
  process.stderr.write(`${message}\n`);
  throw new Error(message);
}

function rendered(value) {
  try { return JSON.stringify(value).slice(0, 500); } catch { return String(value).slice(0, 500); }
}

function asPath(value) {
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof URL) {
    try { return path.resolve(String(value)); } catch { return ''; }
  }
  return '';
}

function leasePath(value) {
  const file = asPath(value);
  if (!file.startsWith(`${home}${path.sep}`)) return false;
  const relative = path.relative(home, file);
  return relative === 'daemon.pid'
    || relative.startsWith('daemon.pid.')
    || relative.startsWith('.daemon-owner-')
    || relative === 'daemon.lock'
    || relative.startsWith(`daemon.lock${path.sep}`);
}

function daemonLogPath(value) {
  return asPath(value) === path.join(home, 'logs', 'daemon.log');
}

function allowedWritePath(value) {
  return leasePath(value) || daemonLogPath(value);
}

function allowedMkdir(value) {
  const file = asPath(value);
  return file === home
    || file === path.join(home, 'state')
    || file === path.join(home, 'logs')
    || file === path.join(home, 'daemon.lock');
}

for (const method of ['writeFileSync', 'appendFileSync', 'createWriteStream']) {
  const original = fs[method];
  fs[method] = function guardedWrite(target, ...args) {
    if (typeof target === 'number' || allowedWritePath(target)) return original.call(this, target, ...args);
    return refuse(`fs.${method}`, asPath(target));
  };
}

const originalOpenSync = fs.openSync;
fs.openSync = function guardedOpen(target, flags, ...args) {
  const writeFlags = typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY
      | fs.constants.O_RDWR
      | fs.constants.O_CREAT
      | fs.constants.O_TRUNC
      | fs.constants.O_APPEND)) !== 0
    : /[+wax]/.test(String(flags));
  if (!writeFlags || allowedWritePath(target)) return originalOpenSync.call(this, target, flags, ...args);
  return refuse('fs.openSync', asPath(target));
};

const originalMkdirSync = fs.mkdirSync;
fs.mkdirSync = function guardedMkdir(target, ...args) {
  if (allowedMkdir(target)) return originalMkdirSync.call(this, target, ...args);
  return refuse('fs.mkdirSync', asPath(target));
};

for (const method of ['renameSync', 'copyFileSync']) {
  const original = fs[method];
  fs[method] = function guardedTwoPathMutation(from, to, ...args) {
    if (leasePath(from) && leasePath(to)) return original.call(this, from, to, ...args);
    return refuse(`fs.${method}`, `${asPath(from)} -> ${asPath(to)}`);
  };
}

for (const method of ['rmSync', 'rmdirSync', 'unlinkSync']) {
  const original = fs[method];
  fs[method] = function guardedRemoval(target, ...args) {
    if (leasePath(target)) return original.call(this, target, ...args);
    return refuse(`fs.${method}`, asPath(target));
  };
}

function allowedChild(command, args) {
  const executable = path.basename(String(command));
  if (executable === 'git') {
    const argv = args ?? [];
    const commandIndex = argv[0] === '-c' && argv[1] === 'core.fsmonitor=false' ? 2 : 0;
    return ['rev-parse', 'status', 'diff', 'ls-files'].includes(String(argv[commandIndex] ?? ''));
  }
  if (path.resolve(String(command)) === path.resolve(process.execPath)) {
    const argv = args ?? [];
    if (argv.some((arg) => /cutover-hold-migrate\.(?:ts|js)$/.test(String(arg)))) return true;
    return argv.at(-1) === '--foreground'
      && argv.some((arg) => /cutover-hold-entry\.(?:ts|js)$/.test(String(arg)));
  }
  if (executable === 'ps') {
    return args?.[0] === '-p'
      && /^\d+$/.test(String(args?.[1] ?? ''))
      && args?.[2] === '-o'
      && ['state=', 'command='].includes(String(args?.[3] ?? ''));
  }
  return false;
}

for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[method];
  childProcess[method] = function guardedChild(command, args, ...rest) {
    const argv = Array.isArray(args) ? args : [];
    if (allowedChild(command, argv)) return original.call(this, command, args, ...rest);
    return refuse(`child_process.${method}`, `${String(command)} ${rendered(argv)}`);
  };
}

globalThis.fetch = async (...args) => refuse('fetch', rendered(args[0]));

for (const client of [http, https]) {
  for (const method of ['request', 'get']) {
    client[method] = (...args) => refuse(`${client === http ? 'http' : 'https'}.${method}`, rendered(args[0]));
  }
}

function allowedTsxIpc(args) {
  let first = args[0];
  while (Array.isArray(first)) [first] = first;
  const target = typeof first === 'string'
    ? first
    : first && typeof first === 'object' && typeof first.path === 'string'
      ? first.path
      : '';
  if (!target || typeof process.getuid !== 'function') return false;
  const resolved = path.resolve(target);
  return path.dirname(resolved) === path.join(path.resolve(os.tmpdir()), `tsx-${process.getuid()}`)
    && [`${process.pid}.pipe`, `${process.ppid}.pipe`].includes(path.basename(resolved));
}

const originalNetConnect = net.connect;
net.connect = function guardedNetConnect(...args) {
  if (allowedTsxIpc(args)) return originalNetConnect.apply(this, args);
  return refuse('net.connect', rendered(args));
};
const originalNetCreateConnection = net.createConnection;
net.createConnection = function guardedNetCreateConnection(...args) {
  if (allowedTsxIpc(args)) return originalNetCreateConnection.apply(this, args);
  return refuse('net.createConnection', rendered(args));
};
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  if (allowedTsxIpc(args)) return originalSocketConnect.apply(this, args);
  return refuse('net.Socket.connect', rendered(args));
};
tls.connect = (...args) => refuse('tls.connect', rendered(args));
dgram.Socket.prototype.connect = function guardedDatagramConnect(...args) {
  return refuse('dgram.Socket.connect', rendered(args));
};
dgram.Socket.prototype.send = function guardedDatagramSend(...args) {
  return refuse('dgram.Socket.send', rendered(args));
};

syncBuiltinESMExports();
