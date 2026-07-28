import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  INTEL_TRANSFORMERS_ENTRY,
  patchTransformersNodeForWasm,
  preparePackagedMacDaemon,
} from './mac-native-deps.mjs';

const TRANSFORMERS_FIXTURE = `
import * as ONNX_NODE from "onnxruntime-node";
  supportedDevices.push("webgpu");
  supportedDevices.push("cpu");
  defaultDevices = ["cpu"];
return await getModelFile(pretrained_model_name_or_path, fullPath, true, options, apis.IS_NODE_ENV);
`;

test('Intel Transformers adapter swaps native ONNX for WASM and buffers model bytes', () => {
  const patched = patchTransformersNodeForWasm(TRANSFORMERS_FIXTURE);
  assert.match(patched, /from "onnxruntime-web"/);
  assert.doesNotMatch(patched, /from "onnxruntime-node"/);
  assert.match(patched, /supportedDevices\.push\("wasm"\)/);
  assert.match(patched, /defaultDevices = \["wasm"\]/);
  assert.match(patched, /options, false\)/);
});

test('Intel Transformers adapter fails closed when the upstream bundle shape drifts', () => {
  assert.throws(
    () => patchTransformersNodeForWasm('import * as ONNX_NODE from "something-else";'),
    /upstream Transformers bundle changed/,
  );
});

test('packaged Intel daemon prunes ARM natives, installs x64 Sharp, and omits native ORT', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-mac-native-x64-'));
  const daemon = path.join(root, 'daemon');
  const stage = path.join(root, 'stage');
  try {
    const daemonModules = path.join(daemon, 'node_modules');
    const stageModules = path.join(stage, 'node_modules');
    for (const base of [daemonModules, stageModules]) {
      mkdirSync(path.join(base, '@img'), { recursive: true });
    }

    const sharpPackage = {
      optionalDependencies: {
        '@img/sharp-darwin-arm64': '0.35.3',
        '@img/sharp-darwin-x64': '0.35.3',
        '@img/sharp-libvips-darwin-arm64': '1.3.2',
        '@img/sharp-libvips-darwin-x64': '1.3.2',
      },
    };
    mkdirSync(path.join(daemonModules, 'sharp'), { recursive: true });
    writeFileSync(path.join(daemonModules, 'sharp', 'package.json'), JSON.stringify(sharpPackage));
    mkdirSync(path.join(daemonModules, 'onnxruntime-node'), { recursive: true });
    writeFileSync(path.join(daemonModules, 'onnxruntime-node', 'package.json'), '{"version":"1.24.3"}');
    mkdirSync(path.join(daemonModules, 'better-sqlite3', 'build', 'Release'), { recursive: true });
    writeFileSync(
      path.join(daemonModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      'x64',
    );
    mkdirSync(path.join(daemonModules, 'onnxruntime-web', 'dist'), { recursive: true });
    writeFileSync(path.join(daemonModules, 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'), 'wasm');

    for (const name of ['sharp-darwin-arm64', 'sharp-libvips-darwin-arm64']) {
      mkdirSync(path.join(daemonModules, '@img', name), { recursive: true });
      writeFileSync(path.join(daemonModules, '@img', name, 'package.json'), '{"version":"arm"}');
    }
    for (const [name, version] of [
      ['sharp-darwin-x64', '0.35.3'],
      ['sharp-libvips-darwin-x64', '1.3.2'],
    ]) {
      mkdirSync(path.join(stageModules, '@img', name, 'lib'), { recursive: true });
      writeFileSync(path.join(stageModules, '@img', name, 'package.json'), JSON.stringify({ version }));
      writeFileSync(path.join(stageModules, '@img', name, 'lib', `${name}.native`), 'x64');
    }

    const transformersDist = path.join(daemonModules, '@huggingface', 'transformers', 'dist');
    mkdirSync(transformersDist, { recursive: true });
    writeFileSync(path.join(transformersDist, 'transformers.node.mjs'), TRANSFORMERS_FIXTURE);

    const inspected = [];
    preparePackagedMacDaemon({
      daemonDir: daemon,
      arch: 'x64',
      stageDir: stage,
      inspectBinary(file, expected) {
        inspected.push([path.basename(file), expected]);
      },
    });

    assert.equal(readFileSync(path.join(transformersDist, INTEL_TRANSFORMERS_ENTRY), 'utf8').includes('from "onnxruntime-web"'), true);
    assert.equal(readFileSync(path.join(daemonModules, '@img', 'sharp-darwin-x64', 'package.json'), 'utf8').includes('0.35.3'), true);
    assert.equal(readFileSync(path.join(daemonModules, '@img', 'sharp-libvips-darwin-x64', 'package.json'), 'utf8').includes('1.3.2'), true);
    assert.equal(readFileSync(path.join(daemonModules, 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'), 'utf8'), 'wasm');
    assert.deepEqual(
      inspected.map(([name]) => name).sort(),
      ['better_sqlite3.node', 'sharp-darwin-x64.native', 'sharp-libvips-darwin-x64.native'],
    );
    assert.throws(() => readFileSync(path.join(daemonModules, 'onnxruntime-node', 'package.json')), /ENOENT/);
    assert.throws(() => readFileSync(path.join(daemonModules, '@img', 'sharp-darwin-arm64', 'package.json')), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaged Apple Silicon daemon retains only arm64 Sharp and native ONNX payloads', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-mac-native-arm64-'));
  const daemon = path.join(root, 'daemon');
  try {
    const modules = path.join(daemon, 'node_modules');
    const img = path.join(modules, '@img');
    mkdirSync(img, { recursive: true });
    mkdirSync(path.join(modules, 'sharp'), { recursive: true });
    writeFileSync(path.join(modules, 'sharp', 'package.json'), JSON.stringify({
      optionalDependencies: {
        '@img/sharp-darwin-arm64': '0.35.3',
        '@img/sharp-libvips-darwin-arm64': '1.3.2',
      },
    }));
    for (const [name, version] of [
      ['sharp-darwin-arm64', '0.35.3'],
      ['sharp-libvips-darwin-arm64', '1.3.2'],
    ]) {
      mkdirSync(path.join(img, name, 'lib'), { recursive: true });
      writeFileSync(path.join(img, name, 'package.json'), JSON.stringify({ version }));
      writeFileSync(path.join(img, name, 'lib', `${name}.native`), 'arm64');
    }
    mkdirSync(path.join(img, 'sharp-darwin-x64'), { recursive: true });

    const sqlite = path.join(modules, 'better-sqlite3', 'build', 'Release');
    mkdirSync(sqlite, { recursive: true });
    writeFileSync(path.join(sqlite, 'better_sqlite3.node'), 'arm64');
    const ort = path.join(modules, 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', 'arm64');
    mkdirSync(ort, { recursive: true });
    writeFileSync(path.join(ort, 'onnxruntime_binding.node'), 'arm64');
    writeFileSync(path.join(ort, 'libonnxruntime.dylib'), 'arm64');

    const inspected = [];
    preparePackagedMacDaemon({
      daemonDir: daemon,
      arch: 'arm64',
      inspectBinary(file, expected) {
        inspected.push([path.basename(file), expected]);
      },
    });

    assert.equal(inspected.length, 5);
    assert.equal(inspected.every(([, expected]) => expected === 'arm64'), true);
    assert.equal(readFileSync(path.join(modules, 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', 'arm64', 'onnxruntime_binding.node'), 'utf8'), 'arm64');
    assert.throws(() => readFileSync(path.join(img, 'sharp-darwin-x64', 'package.json')), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
