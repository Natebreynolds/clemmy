#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const PROBE_FILENAME = 'windows-private-filesystem-probe.exe';
export const PROBE_RESPONSE = 'private-acl-ok-v2';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Policy lives only in the canonical TypeScript module's exported C# class.
// This driver parses a closed typed request and delegates to that exact class.
export const WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER = String.raw`
[System.Runtime.Serialization.DataContract]
public sealed class ClemPrivateAclRequest {
  [System.Runtime.Serialization.DataMember(Name="version",IsRequired=true)] public int Version;
  [System.Runtime.Serialization.DataMember(Name="path",IsRequired=true)] public string Path;
  [System.Runtime.Serialization.DataMember(Name="dev",IsRequired=true)] public string Dev;
  [System.Runtime.Serialization.DataMember(Name="ino",IsRequired=true)] public string Ino;
  [System.Runtime.Serialization.DataMember(Name="nlink",IsRequired=true)] public string Nlink;
  [System.Runtime.Serialization.DataMember(Name="directory",IsRequired=true)] public bool Directory;
  [System.Runtime.Serialization.DataMember(Name="harden",IsRequired=true)] public bool Harden;
  [System.Runtime.Serialization.DataMember(Name="allowInheritedPrivate",IsRequired=true)] public bool AllowInheritedPrivate;
  [System.Runtime.Serialization.DataMember(Name="syntheticDiagnostic",IsRequired=true)] public bool SyntheticDiagnostic;
}
public static class ClemPrivateAclMain {
  static void CheckFields(byte[] bytes) {
    var types=new System.Collections.Generic.Dictionary<string,string> {
      {"version","number"},{"path","string"},{"dev","string"},{"ino","string"},{"nlink","string"},
      {"directory","boolean"},{"harden","boolean"},{"allowInheritedPrivate","boolean"},{"syntheticDiagnostic","boolean"}
    };
    var seen=new System.Collections.Generic.HashSet<string>(); bool root=false;
    using(var reader=System.Runtime.Serialization.Json.JsonReaderWriterFactory.CreateJsonReader(bytes,System.Xml.XmlDictionaryReaderQuotas.Max)) {
      while(reader.Read()) {
        if(reader.NodeType!=System.Xml.XmlNodeType.Element) continue;
        if(reader.Depth==0) {
          if(root || reader.GetAttribute("type")!="object") throw new InvalidOperationException("private ACL object refused");
          root=true; continue;
        }
        string type;
        if(reader.Depth!=1 || !types.TryGetValue(reader.LocalName,out type) || !seen.Add(reader.LocalName) || reader.GetAttribute("type")!=type)
          throw new InvalidOperationException("private ACL fields refused");
      }
    }
    if(!root || seen.Count!=types.Count) throw new InvalidOperationException("private ACL fields missing");
  }
  static ulong Identity(string value) {
    ulong result;
    if(String.IsNullOrEmpty(value) || value.Length>20 || !UInt64.TryParse(value,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out result))
      throw new InvalidOperationException("private ACL identity refused");
    return result;
  }
  public static int Main(string[] args) {
    ClemPrivateAclRequest request=null;
    try {
      if(args.Length!=0) throw new InvalidOperationException("private ACL arguments refused");
      Console.InputEncoding=new UTF8Encoding(false,true);
      Console.OutputEncoding=new UTF8Encoding(false,true);
      var text=new StringBuilder(); var chunk=new char[1024]; int count;
      while((count=Console.In.Read(chunk,0,chunk.Length))>0) {
        text.Append(chunk,0,count);
        if(text.Length>65536) throw new InvalidOperationException("private ACL input refused");
      }
      byte[] bytes=new UTF8Encoding(false,true).GetBytes(text.ToString());
      CheckFields(bytes);
      var serializer=new System.Runtime.Serialization.Json.DataContractJsonSerializer(typeof(ClemPrivateAclRequest));
      using(var input=new MemoryStream(bytes,false)) {
        request=(ClemPrivateAclRequest)serializer.ReadObject(input);
        if(input.Position!=input.Length) throw new InvalidOperationException("private ACL trailing input refused");
      }
      if(request==null || request.Version!=2 || (request.Harden && request.AllowInheritedPrivate))
        throw new InvalidOperationException("private ACL protocol refused");
      ClemPrivateAcl.Apply(request.Path,Identity(request.Dev),Identity(request.Ino),Identity(request.Nlink),request.Directory,request.Harden,request.AllowInheritedPrivate);
      Console.Out.Write("private-acl-ok-v2");
      return 0;
    } catch(Exception error) {
      string diagnostic=request!=null && request.SyntheticDiagnostic ? error.ToString() : "private-acl-refused-v2";
      Console.Error.Write(diagnostic.Length<=4096 ? diagnostic : diagnostic.Substring(0,4096));
      return 1;
    }
  }
}
`;

export function windowsCompilerEnvironment(parent) {
  return Object.fromEntries(Object.entries(parent).filter(([key, value]) => typeof value === 'string'
    && /^(?:systemroot|windir|systemdrive|comspec|pathext|temp|tmp|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
}

function environmentValue(env, name) {
  return Object.entries(env).find(([key, value]) => key.toLowerCase() === name.toLowerCase() && value)?.[1];
}

export function resolveWindowsAclCompiler(env = process.env, run = spawnSync, isFile = filename => existsSync(filename) && lstatSync(filename).isFile()) {
  const programRoots = ['ProgramFiles(x86)', 'ProgramFiles'].map(name => environmentValue(env, name)).filter(Boolean);
  if (!programRoots.length || programRoots.some(root => !path.win32.isAbsolute(root))) throw new Error('Windows build requires an absolute Visual Studio installation root.');
  const vswhere = programRoots.map(root => path.win32.join(root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')).find(isFile);
  if (!vswhere) throw new Error('Windows build requires Visual Studio Roslyn compiler discovery.');
  const result = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\Roslyn\\csc.exe'], {
    // A cold runner's first vswhere scan can take well over ten seconds
    // (run 37655662679 failed at the old 10 s bound); the exact-compiler rule is unchanged.
    env: windowsCompilerEnvironment(env), encoding: 'utf8', shell: false, windowsHide: true, timeout: 90_000, maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Windows C# compiler discovery failed.');
  const candidates = String(result.stdout).trim().split(/\r?\n/).filter(Boolean);
  const compiler = candidates.find(candidate => path.win32.isAbsolute(candidate)
    && path.win32.basename(candidate).toLowerCase() === 'csc.exe'
    && programRoots.some(root => { const relative = path.win32.relative(root, candidate); return relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative); }) && isFile(candidate));
  if (!compiler) throw new Error('Windows C# compiler is outside the expected installed Visual Studio roots.');
  return compiler;
}

export function assertWindowsAclProbeManifest(directory, classSource, driverSource = WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const bytes = readFileSync(path.join(directory, PROBE_FILENAME));
  if (manifest.version !== 2 || manifest.target !== 'windows-x64-netframework4'
    || manifest.classSourceSha256 !== sha256(classSource) || manifest.driverSourceSha256 !== sha256(driverSource)
    || manifest.probeSha256 !== sha256(bytes) || manifest.probeBytes !== bytes.length
    || !/^[0-9a-f]{64}$/.test(manifest.compilerSha256) || manifest.deterministic !== true
    || manifest.response !== PROBE_RESPONSE) throw new Error('Windows ACL probe differs from the canonical policy/driver build.');
  return manifest;
}

export async function buildWindowsAclProbe() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows ACL native compilation requires an actual Windows x64 host.');
  const { tsImport } = await import('tsx/esm/api');
  const { WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE: classSource } = await tsImport(
    // A module specifier must be a file URL: on Windows an absolute drive path is refused by the ESM loader.
    pathToFileURL(path.join(rootDir, 'src/runtime/windows-private-filesystem.ts')).href, import.meta.url);
  if (typeof classSource !== 'string' || !classSource.includes('public static class ClemPrivateAcl')) throw new Error('Canonical Windows ACL class source is unavailable.');
  const compiler = resolveWindowsAclCompiler();
  const systemRoot = environmentValue(process.env, 'SystemRoot');
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows compiler requires absolute SystemRoot.');
  const framework = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const references = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Xml.dll', 'System.Runtime.Serialization.dll'].map(name => path.join(framework, name));
  if (references.some(filename => !existsSync(filename))) throw new Error('Windows .NET Framework4 reference assemblies are unavailable.');
  const parent = path.join(rootDir, 'output'); mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'windows-private-filesystem-build-'));
  const output = path.join(rootDir, 'output', 'windows-private-filesystem');
  try {
    const source = path.join(temporary, 'probe.cs');
    const executable = path.join(temporary, PROBE_FILENAME);
    writeFileSync(source, classSource + '\n' + WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER, { flag: 'wx' });
    const result = spawnSync(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/langversion:5', '/optimize+', '/debug-', '/deterministic+',
      `/pathmap:${temporary}=/canonical/windows-private-filesystem`, `/out:${executable}`,
      ...references.map(filename => `/reference:${filename}`), source], {
      env: windowsCompilerEnvironment(process.env), cwd: temporary, encoding: 'utf8', shell: false,
      windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Canonical Windows ACL native probe compilation failed.');
    const bytes = readFileSync(executable);
    const manifest = { version: 2, target: 'windows-x64-netframework4', classSourceSha256: sha256(classSource),
      driverSourceSha256: sha256(WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER), probeSha256: sha256(bytes), probeBytes: bytes.length,
      compilerSha256: sha256(readFileSync(compiler)), references: references.map(filename => ({ name: path.basename(filename), sha256: sha256(readFileSync(filename)) })),
      deterministic: true, response: PROBE_RESPONSE, providerCalls: 0, credentialOperations: 0 };
    writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    rmSync(source);
    assertWindowsAclProbeManifest(temporary, classSource);
    // This path contains only compiler-owned build output, never credential or
    // permission receipts; canonical source drift is checked by every caller.
    rmSync(output, { recursive: true, force: true }); renameSync(temporary, output);
    return { directory: output, ...manifest };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsAclProbe().then(() => process.stdout.write('Canonical Windows ACL probe compiled; permission qualification remains pending.\n')).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
