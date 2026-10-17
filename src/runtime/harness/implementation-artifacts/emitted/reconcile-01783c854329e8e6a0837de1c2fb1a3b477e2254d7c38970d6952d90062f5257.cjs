var import_meta_url = require("node:url").pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/shared/closed-canonical-json.ts
var CLOSED_CANONICAL_JSON_DEFAULTS, SEALED_CALL_CANONICAL_LIMITS;
var init_closed_canonical_json = __esm({
  "src/shared/closed-canonical-json.ts"() {
    "use strict";
    CLOSED_CANONICAL_JSON_DEFAULTS = Object.freeze({
      maxDepth: 32,
      maxNodes: 2e4,
      maxStringBytes: 64e3,
      maxTotalBytes: 512e3
    });
    SEALED_CALL_CANONICAL_LIMITS = Object.freeze({
      maxDepth: 32,
      maxNodes: 2e6,
      maxStringBytes: 8e6,
      maxTotalBytes: 8e6
    });
  }
});

// src/runtime/security.ts
function isPlaceholderSecret(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "changeme" || normalized === "change-me" || normalized === "placeholder" || normalized === "secret" || normalized === "webhook_secret" || normalized.includes("replace_me") || normalized.includes("your_") || normalized.includes("example");
}
function isStrongLocalSecret(value) {
  const trimmed = value.trim();
  if (trimmed.length < 24) return false;
  if (isPlaceholderSecret(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed) && /[0-9_-]/.test(trimmed);
}
var init_security = __esm({
  "src/runtime/security.ts"() {
    "use strict";
  }
});

// src/runtime/ascii-json.ts
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
var init_ascii_json = __esm({
  "src/runtime/ascii-json.ts"() {
    "use strict";
  }
});

// src/runtime/windows-private-filesystem.ts
function windowsPrivateFilesystemProbeLocation() {
  const filename = typeof __filename === "string" ? __filename : (0, import_node_url.fileURLToPath)(import_meta_url);
  const directory = import_node_path.default.dirname(filename);
  for (let ancestor = directory; ; ancestor = import_node_path.default.dirname(ancestor)) {
    if (import_node_path.default.basename(ancestor).toLowerCase() === "daemon" && (0, import_node_fs.existsSync)(import_node_path.default.join(import_node_path.default.dirname(ancestor), "windows-private-filesystem"))) {
      return { directory: import_node_path.default.join(import_node_path.default.dirname(ancestor), "windows-private-filesystem"), packaged: true };
    }
    if (import_node_path.default.dirname(ancestor) === ancestor) break;
  }
  const packageRoot = import_node_path.default.resolve(directory, "../..");
  if (import_node_path.default.basename(packageRoot).toLowerCase() === "daemon") {
    return { directory: import_node_path.default.join(import_node_path.default.dirname(packageRoot), "windows-private-filesystem"), packaged: true };
  }
  const asarIndex = filename.toLowerCase().indexOf(`${import_node_path.default.sep}app.asar${import_node_path.default.sep}`);
  if (asarIndex >= 0) {
    const resources = filename.slice(0, asarIndex);
    if (!import_node_path.default.isAbsolute(resources)) throw new WindowsPrivateFilesystemError();
    return { directory: import_node_path.default.join(resources, "windows-private-filesystem"), packaged: true };
  }
  const repoRoot = import_node_path.default.basename(import_node_path.default.dirname(directory)) === "desktop" ? import_node_path.default.resolve(directory, "../../..") : packageRoot;
  return { directory: import_node_path.default.join(repoRoot, "output", "windows-private-filesystem"), packaged: false };
}
function windowsPrivateFilesystemClassSourceSha256() {
  return (0, import_node_crypto.createHash)("sha256").update(WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE).digest("hex");
}
function readStableBuildArtifact(target) {
  const before = (0, import_node_fs.lstatSync)(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino === 0n || before.size > 16n * 1024n * 1024n) throw new WindowsPrivateFilesystemError();
  const bytes = (0, import_node_fs.readFileSync)(target);
  const after = (0, import_node_fs.lstatSync)(target, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new WindowsPrivateFilesystemError();
  return bytes;
}
function qualifiedNativeProbe() {
  const location = windowsPrivateFilesystemProbeLocation();
  const probe = import_node_path.default.join(location.directory, "windows-private-filesystem-probe.exe");
  const manifestFile = import_node_path.default.join(location.directory, "manifest.json");
  if (!(0, import_node_fs.existsSync)(probe) && !(0, import_node_fs.existsSync)(manifestFile) && !location.packaged) return null;
  try {
    const manifest = JSON.parse(readStableBuildArtifact(manifestFile).toString("utf8"));
    if (manifest.version !== 2 || manifest.classSourceSha256 !== windowsPrivateFilesystemClassSourceSha256() || typeof manifest.probeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.probeSha256)) throw new WindowsPrivateFilesystemError();
    if ((0, import_node_crypto.createHash)("sha256").update(readStableBuildArtifact(probe)).digest("hex") !== manifest.probeSha256) throw new WindowsPrivateFilesystemError();
    return probe;
  } catch (cause) {
    throw new WindowsPrivateFilesystemError(cause);
  }
}
function assertWindowsPrivateFilesystem(target, identity, kind, harden = false, options = {}) {
  if (process.platform !== "win32") throw new Error("Windows private ACL verification called on another platform");
  if (!import_node_path.default.isAbsolute(target) || target.length > 16e3 || /\0/.test(target)) throw new Error("private ACL target is invalid");
  const syntheticHome = process.env.CLEMENTINE_HOME ?? "";
  const relative = import_node_path.default.relative(syntheticHome, target);
  const syntheticDiagnostic = process.env.CLEMMY_TEST_ISOLATED_HOME === "1" && process.env.CLEMMY_TEST_PRIVATE_ACL_DIAGNOSTICS === "1" && /^clem-private-ntfs-test-/.test(import_node_path.default.basename(syntheticHome)) && !relative.startsWith("..") && !import_node_path.default.isAbsolute(relative);
  const allowInheritedPrivate = !harden && options.allowInheritedPrivate === true;
  const input = asciiJson({ version: 2, path: target, dev: String(identity.dev), ino: String(identity.ino), nlink: String(identity.nlink), directory: kind === "directory", harden, allowInheritedPrivate, syntheticDiagnostic });
  const native = qualifiedNativeProbe();
  const systemRoot = Object.entries(process.env).find(([key, value]) => key.toLowerCase() === "systemroot" && value)?.[1] ?? "C:\\Windows";
  if (!import_node_path.default.isAbsolute(systemRoot)) throw new WindowsPrivateFilesystemError();
  const command = native ?? import_node_path.default.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = native ? [] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_PROGRAM, "utf16le").toString("base64")];
  const env2 = native ? Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== void 0 && /^(?:systemroot|windir|systemdrive|comspec|pathext|temp|tmp)$/i.test(key))) : process.env;
  const result = (0, import_node_child_process.spawnSync)(command, args, {
    input,
    env: env2,
    encoding: "utf8",
    windowsHide: true,
    timeout: native ? 15e3 : 1e4,
    maxBuffer: 4096
  });
  if (result.error || result.status !== 0 || result.stdout !== "private-acl-ok-v2") {
    throw new WindowsPrivateFilesystemError(syntheticDiagnostic ? String(result.stderr || result.error?.message || "no ACL receipt").slice(0, 4096) : void 0);
  }
  return { backend: native ? "native" : "powershell-development", policy: allowInheritedPrivate ? "credential-inherited-private-v1" : "strict" };
}
var import_node_child_process, import_node_crypto, import_node_fs, import_node_path, import_node_url, WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE, ACL_PROGRAM, WindowsPrivateFilesystemError;
var init_windows_private_filesystem = __esm({
  "src/runtime/windows-private-filesystem.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_crypto = require("node:crypto");
    import_node_fs = require("node:fs");
    import_node_path = __toESM(require("node:path"), 1);
    import_node_url = require("node:url");
    init_ascii_json();
    WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ClemPrivateAcl {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint size,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder name,uint size,out uint serial,out uint component,out uint flags,StringBuilder fs,uint fsSize);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle h,int type,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static void Require(bool ok,string stage="acl_policy") { if(!ok) throw new InvalidOperationException("private ACL "+stage+" failed"); }
  static RawSecurityDescriptor Read(SafeFileHandle h) {
    IntPtr owner,group,dacl,sacl,sd;
    Require(GetSecurityInfo(h,1,5,out owner,out group,out dacl,out sacl,out sd)==0);
    try {
      uint count=GetSecurityDescriptorLength(sd); Require(count>0 && count<=65536);
      byte[] bytes=new byte[count]; Marshal.Copy(sd,bytes,0,(int)count);
      return new RawSecurityDescriptor(bytes,0);
    } finally { LocalFree(sd); }
  }
  static bool Trusted(SecurityIdentifier sid, SecurityIdentifier user) {
    return sid!=null && (sid.Equals(user) || sid.Value=="S-1-5-18" || sid.Value=="S-1-5-32-544");
  }
  static void Verify(RawSecurityDescriptor sd,SecurityIdentifier user,bool directory,bool allowInheritedPrivate) {
    Require(Trusted(sd.Owner,user));
    Require((allowInheritedPrivate || (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected)!=0) && sd.DiscretionaryAcl!=null);
    Require(sd.DiscretionaryAcl.Count>0 && sd.DiscretionaryAcl.Count<=3);
    bool own=false; var seen=new System.Collections.Generic.HashSet<string>();
    AceFlags flags=directory ? AceFlags.ContainerInherit|AceFlags.ObjectInherit : AceFlags.None;
    foreach(GenericAce raw in sd.DiscretionaryAcl) {
      CommonAce ace=raw as CommonAce;
      Require(ace!=null && !ace.IsCallback && ace.AceQualifier==AceQualifier.AccessAllowed);
      Require(Trusted(ace.SecurityIdentifier,user) && seen.Add(ace.SecurityIdentifier.Value));
      // Credential-only legacy admission inspects the CURRENT effective ACL.
      // It never repairs an inherited ACL or accepts an inherit-only, callback,
      // deny, duplicate or untrusted rule. Strict stores retain exact flags.
      AceFlags allowed=flags|AceFlags.Inherited;
      Require((allowInheritedPrivate ? (ace.AceFlags & ~allowed)==0 : ace.AceFlags==flags) && ace.AccessMask==0x1f01ff);
      if(ace.SecurityIdentifier.Equals(user)) own=true;
    }
    Require(own);
  }
  static void Harden(SafeFileHandle h,RawSecurityDescriptor old,SecurityIdentifier user,bool directory) {
    Require(Trusted(old.Owner,user));
    RawAcl acl=new RawAcl(2,3);
    AceFlags flags=directory ? AceFlags.ContainerInherit|AceFlags.ObjectInherit : AceFlags.None;
    foreach(string sid in new[]{user.Value,"S-1-5-18","S-1-5-32-544"})
      acl.InsertAce(acl.Count,new CommonAce(flags,AceQualifier.AccessAllowed,0x1f01ff,new SecurityIdentifier(sid),false,null));
    var sd=new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent|ControlFlags.DiscretionaryAclProtected,old.Owner,old.Group,null,acl);
    byte[] bytes=new byte[sd.BinaryLength]; sd.GetBinaryForm(bytes,0);
    GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
    try {
      bool present,defaulted; IntPtr dacl;
      Require(GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out dacl,out defaulted) && present && dacl!=IntPtr.Zero);
      Require(SetSecurityInfo(h,1,0x80000004,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero)==0);
    } finally { pinned.Free(); }
  }
  public static void Apply(string target,ulong volume,ulong inode,ulong links,bool directory,bool harden,bool allowInheritedPrivate) {
    Require(!String.IsNullOrEmpty(target) && target.Length<=16000 && Path.IsPathRooted(target));
    using(var h=CreateFileW(target,0x20080u|(harden?0x40000u:0u),3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      Require(!h.IsInvalid,"open_handle");
      Info info; Require(GetFileInformationByHandle(h,out info));
      Require(info.Volume==volume && (((ulong)info.IndexHigh<<32)|info.IndexLow)==inode && inode!=0,"identity");
      Require(info.Links==links && (!harden || directory || links==1));
      Require((info.Attributes&0x400)==0 && ((info.Attributes&0x10)!=0)==directory);
      var canonical=new StringBuilder(32768);
      uint count=GetFinalPathNameByHandleW(h,canonical,32768,0); Require(count>0 && count<32768);
      string observed=canonical.ToString(); if(observed.StartsWith(@"\\?\")) observed=observed.Substring(4);
      Require(String.Equals(observed,Path.GetFullPath(target),StringComparison.OrdinalIgnoreCase),"canonical_path");
      uint serial,component,flags; var fs=new StringBuilder(32);
      Require(GetVolumeInformationByHandleW(h,null,0,out serial,out component,out flags,fs,32) && fs.ToString()=="NTFS","ntfs_volume");
      var user=WindowsIdentity.GetCurrent().User; Require(user!=null);
      var sd=Read(h);
      if(harden) { Harden(h,sd,user,directory); sd=Read(h); }
      Verify(sd,user,directory,!harden && allowInheritedPrivate);
      Info after; Require(GetFileInformationByHandle(h,out after));
      Require(after.Volume==info.Volume && after.IndexHigh==info.IndexHigh && after.IndexLow==info.IndexLow && after.Links==info.Links);
    }
  }
}
`;
    ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
try {
# The request is ASCII-only JSON (asciiJson), readable in any console code page.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true) } catch { }
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
` + WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE + String.raw`
'@
if($p.version -ne 2) { throw 'unsupported private ACL protocol' }
[ClemPrivateAcl]::Apply($p.path,[UInt64]::Parse($p.dev),[UInt64]::Parse($p.ino),[UInt64]::Parse($p.nlink),[bool]$p.directory,[bool]$p.harden,[bool]$p.allowInheritedPrivate)
[Console]::Out.Write('private-acl-ok-v2')
} catch {
  if($p.syntheticDiagnostic -eq $true) { [Console]::Error.Write($_.ToString()) }
  else { [Console]::Error.Write('private-acl-refused-v1') }
  exit 1
}
`;
    WindowsPrivateFilesystemError = class extends Error {
      constructor(cause) {
        super("Windows private filesystem ACL could not be verified. Check NTFS folder access and the Clementine native helper installation, then retry. Development fallback also requires PowerShell access.", cause === void 0 ? void 0 : { cause });
        this.name = "WindowsPrivateFilesystemError";
      }
    };
  }
});

// src/runtime/sync-directory.ts
function syncDirectoryMetadata(directory, options = {}) {
  if ((options.platform ?? process.platform) === "win32") return "unsupported_on_windows";
  const io = options.io ?? nativeIo;
  const fd = io.open(directory, options.flags ?? "r");
  try {
    io.sync(fd);
  } finally {
    io.close(fd);
  }
  return "synced";
}
var import_node_fs2, nativeIo;
var init_sync_directory = __esm({
  "src/runtime/sync-directory.ts"() {
    "use strict";
    import_node_fs2 = require("node:fs");
    nativeIo = {
      open: (directory, flags) => (0, import_node_fs2.openSync)(directory, flags),
      sync: import_node_fs2.fsyncSync,
      close: import_node_fs2.closeSync
    };
  }
});

// src/runtime/credential-private-filesystem.ts
function isCredentialStoragePrivacyError(error) {
  return error instanceof Error && error.name === "CredentialStoragePrivacyError";
}
function createCredentialFilePolicy(dependencies = {}) {
  const windows = (dependencies.platform ?? process.platform) === "win32";
  const observeAcl = dependencies.checkAcl ?? assertWindowsPrivateFilesystem;
  const now = dependencies.now ?? (() => performance.now());
  const verified = /* @__PURE__ */ new Map();
  const checkAcl = (target, stat, kind, harden = false, options) => {
    const key = `${kind}\0${options?.allowInheritedPrivate === true}\0${target}`;
    const prior = verified.get(key);
    verified.delete(key);
    if (!harden && prior && now() - prior.at < CREDENTIAL_ACL_REUSE_MS && prior.stat.dev === stat.dev && prior.stat.ino === stat.ino && (kind === "directory" || same(prior.stat, stat))) {
      verified.set(key, prior);
      return;
    }
    observeAcl(target, stat, kind, harden, options);
    if (!harden) verified.set(key, { at: now(), stat });
  };
  const assertMissingPathParents = (directory, verifyNearestPrivate = true) => {
    let current = directory;
    let nearestObserved = false;
    while (true) {
      try {
        const stat = (0, import_node_fs3.lstatSync)(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw new CredentialStoragePrivacyError();
        if (!nearestObserved) {
          if (verifyNearestPrivate) privateDirectory(current);
          nearestObserved = true;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = import_node_path2.default.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  const privateDirectory = (directory, harden = false) => {
    const before = (0, import_node_fs3.lstatSync)(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.ino === 0n) throw new CredentialStoragePrivacyError();
    checkAcl(directory, before, "directory", harden, { allowInheritedPrivate: !harden });
    const after = (0, import_node_fs3.lstatSync)(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink() || !after.isDirectory()) throw new CredentialStoragePrivacyError();
  };
  const ensureDirectory = (directory) => {
    try {
      (0, import_node_fs3.lstatSync)(directory);
      privateDirectory(directory);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = import_node_path2.default.dirname(directory);
    if (parent === directory) throw new CredentialStoragePrivacyError();
    ensureDirectory(parent);
    (0, import_node_fs3.mkdirSync)(directory, { mode: 448 });
    privateDirectory(directory, true);
  };
  const read = (target, optionalExternalSource = false) => {
    if (!windows) return (0, import_node_fs3.existsSync)(target) ? (0, import_node_fs3.readFileSync)(target, "utf8") : void 0;
    let fd;
    try {
      const directory = import_node_path2.default.dirname(target);
      if (!import_node_path2.default.isAbsolute(target) || target.includes("\0")) throw new CredentialStoragePrivacyError();
      let entry;
      try {
        entry = (0, import_node_fs3.lstatSync)(target, { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          assertMissingPathParents(directory, !optionalExternalSource);
          return void 0;
        }
        throw error;
      }
      if (!regular(entry) || entry.size > BigInt(MAX_CREDENTIAL_BYTES)) throw new CredentialStoragePrivacyError();
      privateDirectory(directory);
      fd = (0, import_node_fs3.openSync)(target, import_node_fs3.constants.O_RDONLY | (import_node_fs3.constants.O_NOFOLLOW ?? 0));
      const before = (0, import_node_fs3.fstatSync)(fd, { bigint: true });
      if (!regular(before) || !same(entry, before)) throw new CredentialStoragePrivacyError();
      checkAcl(target, before, "file", false, { allowInheritedPrivate: true });
      const raw = (0, import_node_fs3.readFileSync)(fd, "utf8");
      const after = (0, import_node_fs3.fstatSync)(fd, { bigint: true });
      if (!regular(after) || !same(before, after) || !same(after, (0, import_node_fs3.lstatSync)(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      checkAcl(target, after, "file", false, { allowInheritedPrivate: true });
      privateDirectory(directory);
      if (!same(after, (0, import_node_fs3.fstatSync)(fd, { bigint: true })) || !same(after, (0, import_node_fs3.lstatSync)(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      return raw;
    } catch (cause) {
      throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
    } finally {
      if (fd !== void 0) (0, import_node_fs3.closeSync)(fd);
    }
  };
  const write = (target, content, format, options) => {
    const pinsPrior = format === "text" && options !== void 0 && Object.hasOwn(options, "expectedPrior");
    const assertExpectedPrior = (observed) => {
      if (pinsPrior && observed !== options.expectedPrior) throw new CredentialStoragePrivacyError();
    };
    if (!windows) {
      if (pinsPrior) {
        try {
          assertExpectedPrior(read(target));
        } catch (cause) {
          throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
        }
      }
      (0, import_node_fs3.mkdirSync)(import_node_path2.default.dirname(target), { recursive: true });
      const temporary2 = `${target}.${process.pid}.${(0, import_node_crypto2.randomUUID)()}.tmp`;
      try {
        (0, import_node_fs3.writeFileSync)(temporary2, content, { encoding: "utf8", mode: 384 });
        if (pinsPrior) assertExpectedPrior(read(target));
        (0, import_node_fs3.renameSync)(temporary2, target);
        try {
          (0, import_node_fs3.chmodSync)(target, 384);
        } catch {
        }
      } catch (cause) {
        if (pinsPrior) throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
        throw cause;
      } finally {
        try {
          (0, import_node_fs3.unlinkSync)(temporary2);
        } catch {
        }
      }
      return;
    }
    let fd;
    let temporary;
    let temporaryIdentity;
    try {
      if (Buffer.byteLength(content) > MAX_CREDENTIAL_BYTES) throw new CredentialStoragePrivacyError();
      const prior = read(target);
      assertExpectedPrior(prior);
      if (prior !== void 0 && format === "json-object") {
        const parsed = JSON.parse(prior);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CredentialStoragePrivacyError();
      }
      const priorIdentity = prior === void 0 ? null : (0, import_node_fs3.lstatSync)(target, { bigint: true });
      const directory = import_node_path2.default.dirname(target);
      ensureDirectory(directory);
      temporary = import_node_path2.default.join(directory, `.${import_node_path2.default.basename(target)}.${process.pid}.${(0, import_node_crypto2.randomUUID)()}.tmp`);
      fd = (0, import_node_fs3.openSync)(temporary, import_node_fs3.constants.O_CREAT | import_node_fs3.constants.O_EXCL | import_node_fs3.constants.O_WRONLY | (import_node_fs3.constants.O_NOFOLLOW ?? 0), 384);
      const empty = (0, import_node_fs3.fstatSync)(fd, { bigint: true });
      temporaryIdentity = empty;
      if (!regular(empty) || empty.size !== 0n) throw new CredentialStoragePrivacyError();
      checkAcl(temporary, empty, "file", true);
      (0, import_node_fs3.writeFileSync)(fd, content, "utf8");
      (0, import_node_fs3.fsyncSync)(fd);
      const written = (0, import_node_fs3.fstatSync)(fd, { bigint: true });
      if (!regular(written) || written.dev !== empty.dev || written.ino !== empty.ino || !same(written, (0, import_node_fs3.lstatSync)(temporary, { bigint: true }))) throw new CredentialStoragePrivacyError();
      checkAcl(temporary, written, "file");
      privateDirectory(directory);
      const current = read(target);
      assertExpectedPrior(current);
      if (current !== prior || priorIdentity && !same(priorIdentity, (0, import_node_fs3.lstatSync)(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      (0, import_node_fs3.closeSync)(fd);
      fd = void 0;
      (0, import_node_fs3.renameSync)(temporary, target);
      temporary = void 0;
      syncDirectoryMetadata(directory);
      if (read(target) !== content) throw new CredentialStoragePrivacyError();
    } catch (cause) {
      throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
    } finally {
      if (fd !== void 0) (0, import_node_fs3.closeSync)(fd);
      if (temporary && temporaryIdentity) {
        try {
          const current = (0, import_node_fs3.lstatSync)(temporary, { bigint: true });
          if (regular(current) && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) (0, import_node_fs3.unlinkSync)(temporary);
        } catch {
        }
      }
    }
  };
  return {
    readCredentialFileSync: (target) => read(target),
    // Optional external .env/CLI files are never hardened. Safe absent files
    // need no private ACL on public package/cwd parents. Present files use the
    // same current parent/file ACL, no-follow and exact identity checks.
    readCredentialSourceFileSync: (target) => read(target, true),
    writeCredentialFileSync: (target, content) => write(target, content, "json-object"),
    /** Optional exact prior bytes bind a caller's read-modify-write composition.
     * An own expectedPrior:undefined requires absence; omitting it pins nothing. */
    writeCredentialTextFileSync: (target, content, options) => write(target, content, "text", options),
    assertCredentialFileReadable: (target) => {
      read(target);
    }
  };
}
var import_node_crypto2, import_node_fs3, import_node_path2, MAX_CREDENTIAL_BYTES, MESSAGE, CredentialStoragePrivacyError, regular, same, CREDENTIAL_ACL_REUSE_MS, policy, readCredentialFileSync, readCredentialSourceFileSync, writeCredentialFileSync, writeCredentialTextFileSync, assertCredentialFileReadable;
var init_credential_private_filesystem = __esm({
  "src/runtime/credential-private-filesystem.ts"() {
    "use strict";
    import_node_crypto2 = require("node:crypto");
    import_node_fs3 = require("node:fs");
    import_node_path2 = __toESM(require("node:path"), 1);
    init_windows_private_filesystem();
    init_sync_directory();
    MAX_CREDENTIAL_BYTES = 8 * 1024 * 1024;
    MESSAGE = "Credential storage privacy or integrity could not be verified. Check NTFS folder permissions and the Clementine installation, then retry; no other credential source was selected. A write may require verification before retrying.";
    CredentialStoragePrivacyError = class extends Error {
      constructor(_cause) {
        super(MESSAGE);
        this.name = "CredentialStoragePrivacyError";
      }
    };
    regular = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino !== 0n;
    same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    CREDENTIAL_ACL_REUSE_MS = 3e4;
    policy = createCredentialFilePolicy();
    readCredentialFileSync = policy.readCredentialFileSync;
    readCredentialSourceFileSync = policy.readCredentialSourceFileSync;
    writeCredentialFileSync = policy.writeCredentialFileSync;
    writeCredentialTextFileSync = policy.writeCredentialTextFileSync;
    assertCredentialFileReadable = policy.assertCredentialFileReadable;
  }
});

// src/config.ts
function realUserHome() {
  try {
    return import_node_os.default.userInfo().homedir;
  } catch {
    return import_node_os.default.homedir();
  }
}
function isTestProcess() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT || process.env.CLEMMY_TEST_ISOLATED_HOME === "1" || process.argv.includes("--test")
  );
}
function parseEnvText(text) {
  const result = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\s+|\r+$/g, "");
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1);
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
function envSearchPaths() {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME === "1") {
    return [import_node_path3.default.join(BASE_DIR, ".env")];
  }
  return [
    import_node_path3.default.join(PKG_DIR, ".env"),
    import_node_path3.default.join(process.cwd(), ".env"),
    import_node_path3.default.join(BASE_DIR, ".env")
  ];
}
function captureEnvFiles() {
  const files = [];
  const environment = {};
  for (const filePath of [...new Set(envSearchPaths())]) {
    const raw = process.platform === "win32" ? readCredentialSourceFileSync(filePath) : (0, import_node_fs4.existsSync)(filePath) ? (0, import_node_fs4.readFileSync)(filePath, "utf-8") : void 0;
    if (raw === void 0) continue;
    files.push(filePath);
    Object.assign(environment, parseEnvText(raw));
  }
  return { files, environment };
}
function getEnv(key, fallback = "") {
  return process.env[key] ?? env[key] ?? fallback;
}
function parseCsvEnv(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
function normalizeWebhookHost(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "localhost") return "127.0.0.1";
  if (trimmed === "::1") return "::1";
  if (trimmed === "0.0.0.0" || trimmed === "::") return trimmed;
  if (/^[A-Za-z0-9.-]+$/.test(trimmed) || /^[0-9a-f:.]+$/i.test(trimmed)) return trimmed;
  return "127.0.0.1";
}
function captureSecretVault() {
  const vaultPath = import_node_path3.default.join(BASE_DIR, "state", "secrets-vault.json");
  let entries = {};
  if (process.platform === "win32" || (0, import_node_fs4.existsSync)(vaultPath)) {
    try {
      const raw = process.platform === "win32" ? readCredentialFileSync(vaultPath) : (0, import_node_fs4.readFileSync)(vaultPath, "utf-8");
      if (raw === void 0) {
        runtimeConfigCaptureObserverForTest?.("secret_vault");
        return Object.freeze(entries);
      }
      const parsed = JSON.parse(raw);
      if (parsed.version === "v1" && parsed.entries) {
        if (process.platform === "win32" && (typeof parsed.entries !== "object" || Array.isArray(parsed.entries) || Object.values(parsed.entries).some((value) => typeof value !== "string"))) throw new CredentialStoragePrivacyError();
        entries = { ...parsed.entries };
      } else if (process.platform === "win32") throw new CredentialStoragePrivacyError();
    } catch (cause) {
      if (process.platform === "win32") throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
      entries = {};
    }
  }
  runtimeConfigCaptureObserverForTest?.("secret_vault");
  return Object.freeze(entries);
}
function readSecretFromFileVaultSync(name) {
  const requestSnapshot = runtimeConfigRequestStorage.getStore();
  const value = requestSnapshot ? requestSnapshot.secretValue(name) : captureSecretVault()[name];
  return value && value.length > 0 ? value : void 0;
}
function resolveOpenAiAgentsTracingDisabled(configuredValue, apiKey) {
  const configured = configuredValue?.trim().toLowerCase() ?? "";
  if (configured === "1" || configured === "true" || configured === "on") return "1";
  if (configured) return void 0;
  return apiKey.trim() ? void 0 : "1";
}
function resolveDiscordEnabled(rawEnabled, hasToken) {
  const raw = rawEnabled.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return hasToken;
}
var import_node_async_hooks, import_node_fs4, import_node_os, import_node_path3, import_node_url2, __filename2, __dirname, PKG_DIR, REAL_USER_HOME, REAL_DEFAULT_CLEMENTINE_HOME, DEFAULT_BASE_DIR, BASE_DIR, initialEnvFiles, ACTIVE_ENV_FILES, env, runtimeConfigCaptureObserverForTest, runtimeConfigRequestStorage, agentsTracingDisabled, ASSISTANT_NAME, OWNER_NAME, OPENAI_API_KEY, AUTH_MODE, CODEX_AUTH_SOURCE_FILE, CODEX_EXECUTABLE, CODEX_INSTALL_PACKAGE, CODEX_SANDBOX_MODE, CODEX_USE_FULL_AUTO, VAULT_DIR, WEBHOOK_ENABLED, WEBHOOK_PORT, WEBHOOK_HOST, WEBHOOK_ALLOW_LAN, MOBILE_APP_PORT, MOBILE_APP_LISTENER_ENABLED, WEBHOOK_SECRET, WEBHOOK_SECRET_IS_STRONG, DISCORD_ENABLED_RAW, DISCORD_HARNESS_ENABLED, DISCORD_BOT_TOKEN, DISCORD_ENABLED, DISCORD_CLIENT_ID, DISCORD_REQUIRE_MENTION, DISCORD_DM_ALLOWED_USERS, DISCORD_ALLOWED_USERS, DISCORD_DM_POLL_INTERVAL_MS, DISCORD_ALLOWED_CHANNELS, DISCORD_PUSH_PROACTIVE_BRIEFS, SLACK_ENABLED_RAW, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ENABLED, SLACK_REQUIRE_MENTION, SLACK_ALLOWED_USERS, SLACK_ALLOWED_CHANNELS, SLACK_PROACTIVE_CHANNEL, LOCAL_MCP_ENABLED, MCP_AUTO_IMPORT_ENABLED, MCP_SERVERS_FILE, COMPOSIO_API_KEY, COMPOSIO_USER_ID;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    import_node_async_hooks = require("node:async_hooks");
    import_node_fs4 = require("node:fs");
    import_node_os = __toESM(require("node:os"), 1);
    import_node_path3 = __toESM(require("node:path"), 1);
    import_node_url2 = require("node:url");
    init_security();
    init_credential_private_filesystem();
    __filename2 = (0, import_node_url2.fileURLToPath)(import_meta_url);
    __dirname = import_node_path3.default.dirname(__filename2);
    PKG_DIR = import_node_path3.default.resolve(__dirname, "..");
    REAL_USER_HOME = process.env.CLEMMY_REAL_USER_HOME || realUserHome();
    REAL_DEFAULT_CLEMENTINE_HOME = import_node_path3.default.resolve(import_node_path3.default.join(REAL_USER_HOME, ".clementine-next"));
    DEFAULT_BASE_DIR = process.env.CLEMENTINE_HOME || REAL_DEFAULT_CLEMENTINE_HOME;
    if (isTestProcess() && import_node_path3.default.resolve(DEFAULT_BASE_DIR) === REAL_DEFAULT_CLEMENTINE_HOME && process.env.CLEMMY_ALLOW_LIVE_HOME_TESTS !== "1") {
      throw new Error(
        "Refusing to bind BASE_DIR to the live Clementine home from a test process. Set CLEMENTINE_HOME to a unique temp directory before importing config, or set CLEMMY_ALLOW_LIVE_HOME_TESTS=1 for an explicit destructive test."
      );
    }
    BASE_DIR = DEFAULT_BASE_DIR;
    initialEnvFiles = captureEnvFiles();
    ACTIVE_ENV_FILES = initialEnvFiles.files;
    env = initialEnvFiles.environment;
    runtimeConfigRequestStorage = new import_node_async_hooks.AsyncLocalStorage();
    agentsTracingDisabled = resolveOpenAiAgentsTracingDisabled(
      getEnv("OPENAI_AGENTS_DISABLE_TRACING", ""),
      process.env.OPENAI_API_KEY ?? ""
    );
    if (agentsTracingDisabled) process.env.OPENAI_AGENTS_DISABLE_TRACING = agentsTracingDisabled;
    ASSISTANT_NAME = getEnv("ASSISTANT_NAME", "Clementine");
    OWNER_NAME = getEnv("OWNER_NAME", "");
    OPENAI_API_KEY = getEnv("OPENAI_API_KEY", "");
    AUTH_MODE = (() => {
      const raw = getEnv("AUTH_MODE", "api_key");
      if (raw === "codex_oauth") return "codex_oauth";
      if (raw === "claude_oauth") return "claude_oauth";
      return "api_key";
    })();
    CODEX_AUTH_SOURCE_FILE = getEnv("CODEX_AUTH_SOURCE_FILE", import_node_path3.default.join(import_node_os.default.homedir(), ".codex", "auth.json"));
    CODEX_EXECUTABLE = getEnv("CODEX_EXECUTABLE", "codex");
    CODEX_INSTALL_PACKAGE = getEnv("CODEX_INSTALL_PACKAGE", "@openai/codex");
    CODEX_SANDBOX_MODE = getEnv("CODEX_SANDBOX_MODE", "workspace-write");
    CODEX_USE_FULL_AUTO = getEnv("CODEX_USE_FULL_AUTO", "true").toLowerCase() === "true";
    VAULT_DIR = import_node_path3.default.join(BASE_DIR, "vault");
    WEBHOOK_ENABLED = getEnv("WEBHOOK_ENABLED", "false").toLowerCase() === "true";
    WEBHOOK_PORT = parseInt(getEnv("WEBHOOK_PORT", "8420"), 10);
    WEBHOOK_HOST = normalizeWebhookHost(getEnv("WEBHOOK_HOST", "127.0.0.1"));
    WEBHOOK_ALLOW_LAN = getEnv("WEBHOOK_ALLOW_LAN", "false").toLowerCase() === "true";
    MOBILE_APP_PORT = parseInt(getEnv("CLEMENTINE_MOBILE_APP_PORT", "8421"), 10);
    MOBILE_APP_LISTENER_ENABLED = getEnv("CLEMENTINE_MOBILE_APP_LISTENER", "on").toLowerCase() !== "off";
    WEBHOOK_SECRET = readSecretFromFileVaultSync("webhook_secret") || getEnv("WEBHOOK_SECRET", "") || "";
    WEBHOOK_SECRET_IS_STRONG = isStrongLocalSecret(WEBHOOK_SECRET);
    DISCORD_ENABLED_RAW = getEnv("DISCORD_ENABLED", "").toLowerCase();
    DISCORD_HARNESS_ENABLED = !["false", "0", "no", "off"].includes(
      getEnv("DISCORD_HARNESS_ENABLED", "true").toLowerCase()
    );
    DISCORD_BOT_TOKEN = readSecretFromFileVaultSync("discord_bot_token") || getEnv("DISCORD_BOT_TOKEN", "") || "";
    DISCORD_ENABLED = resolveDiscordEnabled(DISCORD_ENABLED_RAW, DISCORD_BOT_TOKEN.length > 0);
    DISCORD_CLIENT_ID = getEnv("DISCORD_CLIENT_ID", "");
    DISCORD_REQUIRE_MENTION = getEnv("DISCORD_REQUIRE_MENTION", "true").toLowerCase() === "true";
    DISCORD_DM_ALLOWED_USERS = parseCsvEnv(getEnv("DISCORD_DM_ALLOWED_USERS", ""));
    DISCORD_ALLOWED_USERS = parseCsvEnv(
      getEnv("DISCORD_ALLOWED_USERS", getEnv("DISCORD_DM_ALLOWED_USERS", ""))
    );
    DISCORD_DM_POLL_INTERVAL_MS = parseInt(getEnv("DISCORD_DM_POLL_INTERVAL_MS", "5000"), 10);
    DISCORD_ALLOWED_CHANNELS = parseCsvEnv(getEnv("DISCORD_ALLOWED_CHANNELS", ""));
    DISCORD_PUSH_PROACTIVE_BRIEFS = getEnv("DISCORD_PUSH_PROACTIVE_BRIEFS", "false").toLowerCase() === "true";
    SLACK_ENABLED_RAW = getEnv("SLACK_ENABLED", "").toLowerCase();
    SLACK_BOT_TOKEN = readSecretFromFileVaultSync("slack_bot_token") || getEnv("SLACK_BOT_TOKEN", "") || "";
    SLACK_APP_TOKEN = readSecretFromFileVaultSync("slack_app_token") || getEnv("SLACK_APP_TOKEN", "") || "";
    SLACK_ENABLED = resolveDiscordEnabled(
      SLACK_ENABLED_RAW,
      SLACK_BOT_TOKEN.length > 0 && SLACK_APP_TOKEN.length > 0
    );
    SLACK_REQUIRE_MENTION = getEnv("SLACK_REQUIRE_MENTION", "true").toLowerCase() === "true";
    SLACK_ALLOWED_USERS = parseCsvEnv(getEnv("SLACK_ALLOWED_USERS", ""));
    SLACK_ALLOWED_CHANNELS = parseCsvEnv(getEnv("SLACK_ALLOWED_CHANNELS", ""));
    SLACK_PROACTIVE_CHANNEL = getEnv("SLACK_PROACTIVE_CHANNEL", "").trim();
    LOCAL_MCP_ENABLED = getEnv("LOCAL_MCP_ENABLED", "true").toLowerCase() === "true";
    MCP_AUTO_IMPORT_ENABLED = getEnv("MCP_AUTO_IMPORT_ENABLED", "false").toLowerCase() === "true";
    MCP_SERVERS_FILE = import_node_path3.default.join(BASE_DIR, "mcp", "servers.json");
    COMPOSIO_API_KEY = getEnv("COMPOSIO_API_KEY", "");
    COMPOSIO_USER_ID = getEnv("COMPOSIO_USER_ID", "");
  }
});

// src/runtime/machine-id.ts
var import_node_path4, MACHINE_ID_FILE;
var init_machine_id = __esm({
  "src/runtime/machine-id.ts"() {
    "use strict";
    import_node_path4 = __toESM(require("node:path"), 1);
    init_config();
    MACHINE_ID_FILE = import_node_path4.default.join(BASE_DIR, "state", "machine-id");
  }
});

// src/shared/stable-json-digest.ts
var init_stable_json_digest = __esm({
  "src/shared/stable-json-digest.ts"() {
    "use strict";
  }
});

// src/tools/tool-contract-store.ts
var import_node_path5, CONTRACTS_ROOT, CONTRACT_TTL_MS, MAX_CONTRACT_CACHE_BYTES;
var init_tool_contract_store = __esm({
  "src/tools/tool-contract-store.ts"() {
    "use strict";
    import_node_path5 = __toESM(require("node:path"), 1);
    init_config();
    init_machine_id();
    init_stable_json_digest();
    CONTRACTS_ROOT = import_node_path5.default.join(BASE_DIR, "memory", "tool-contracts");
    CONTRACT_TTL_MS = 30 * 24 * 60 * 6e4;
    MAX_CONTRACT_CACHE_BYTES = 64 * 1024 * 1024;
  }
});

// src/tools/composio-schema-cache.ts
var SCHEMA_TTL_MS;
var init_composio_schema_cache = __esm({
  "src/tools/composio-schema-cache.ts"() {
    "use strict";
    init_closed_canonical_json();
    init_tool_contract_store();
    SCHEMA_TTL_MS = 30 * 6e4;
  }
});

// src/runtime/harness/capability-live-identity.ts
var import_node_path6, STORE;
var init_capability_live_identity = __esm({
  "src/runtime/harness/capability-live-identity.ts"() {
    "use strict";
    import_node_path6 = __toESM(require("node:path"), 1);
    init_config();
    STORE = import_node_path6.default.join(BASE_DIR, "state", "capability-live-identity.json");
  }
});

// src/runtime/harness/mutation-verification-contract.ts
var init_mutation_verification_contract = __esm({
  "src/runtime/harness/mutation-verification-contract.ts"() {
    "use strict";
  }
});

// src/runtime/harness/provider-read-evidence.ts
var init_provider_read_evidence = __esm({
  "src/runtime/harness/provider-read-evidence.ts"() {
    "use strict";
  }
});

// src/runtime/harness/atomic-input-content-contract.ts
var init_atomic_input_content_contract = __esm({
  "src/runtime/harness/atomic-input-content-contract.ts"() {
    "use strict";
    init_closed_canonical_json();
    init_mutation_verification_contract();
    init_provider_read_evidence();
  }
});

// src/runtime/harness/capability-manifest.ts
function canonicalManifestBytes(manifest) {
  return JSON.stringify({
    version: manifest.version,
    manifestId: manifest.manifestId,
    providerKind: manifest.providerKind,
    operationId: manifest.operationId,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    // Preserve byte compatibility for already-installed manifests: absence is
    // omitted rather than encoded as null. New external manifests bind these
    // facts into their digest.
    ...manifest.externalDefinition ? {
      externalDefinition: {
        version: manifest.externalDefinition.version,
        providerInputSchemaDigest: manifest.externalDefinition.providerInputSchemaDigest,
        ...manifest.externalDefinition.providerOutputSchemaObserved === true ? { providerOutputSchemaObserved: true } : {},
        ...manifest.externalDefinition.providerOutputSchemaDigest ? { providerOutputSchemaDigest: manifest.externalDefinition.providerOutputSchemaDigest } : {},
        semanticName: manifest.externalDefinition.semanticName,
        ...manifest.externalDefinition.verification ? { verification: manifest.externalDefinition.verification } : {},
        behaviorHints: { ...manifest.externalDefinition.behaviorHints }
      }
    } : {},
    effect: manifest.effect,
    ...manifest.operationSemantics ? { operationSemantics: manifest.operationSemantics } : {},
    destination: manifest.destination ?? null,
    accountId: manifest.accountId,
    idempotency: manifest.idempotency,
    reconciliation: manifest.reconciliation,
    outputContract: manifest.outputContract,
    purpose: manifest.purpose,
    acceptedInputKinds: [...manifest.acceptedInputKinds],
    producedOutputKinds: [...manifest.producedOutputKinds],
    applicableDeliverableKinds: [...manifest.applicableDeliverableKinds],
    evidenceContract: {
      kinds: [...manifest.evidenceContract.kinds],
      readbackRequired: manifest.evidenceContract.readbackRequired
    },
    continuationContract: manifest.continuationContract ?? null,
    readbackContract: manifest.readbackContract ?? null,
    provenance: manifest.provenance,
    lifecycle: manifest.lifecycle,
    delegatedFrom: manifest.delegatedFrom ?? null,
    argumentCompiler: manifest.argumentCompiler,
    invokePortId: manifest.invokePortId,
    reconcilePortId: manifest.reconcilePortId ?? null
  });
}
function capabilityManifestDigest(manifest) {
  return (0, import_node_crypto3.createHash)("sha256").update(canonicalManifestBytes(manifest), "utf8").digest("hex");
}
var import_node_crypto3;
var init_capability_manifest = __esm({
  "src/runtime/harness/capability-manifest.ts"() {
    "use strict";
    import_node_crypto3 = require("node:crypto");
    init_mutation_verification_contract();
    init_atomic_input_content_contract();
  }
});

// src/runtime/harness/isolated-test-contract.ts
var init_isolated_test_contract = __esm({
  "src/runtime/harness/isolated-test-contract.ts"() {
    "use strict";
  }
});

// src/runtime/harness/implementation-artifacts/attested-transport.ts
function bindAttestedTransport(transport) {
  bound = transport;
}
function requireAttestedTransport() {
  if (!bound) {
    throw new Error("attested provider transport is not bound");
  }
  return bound;
}
var bound;
var init_attested_transport = __esm({
  "src/runtime/harness/implementation-artifacts/attested-transport.ts"() {
    "use strict";
    bound = null;
  }
});

// src/runtime/harness/implementation-artifacts/host-local-write-carrier.ts
function bindHostLocalWriteCarrier(carrier) {
  bound2 = carrier;
}
function peekHostLocalWriteCarrier() {
  return bound2;
}
var bound2;
var init_host_local_write_carrier = __esm({
  "src/runtime/harness/implementation-artifacts/host-local-write-carrier.ts"() {
    "use strict";
    bound2 = null;
  }
});

// src/runtime/harness/production-capability-adapters.ts
function looksLikeContentDigest(value) {
  return /^[a-f0-9]{64}$/i.test(value);
}
function attestedExpectationForManifest(manifest) {
  const external = manifest.externalDefinition;
  return {
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    ...external ? {
      providerInputSchemaDigest: external.providerInputSchemaDigest,
      ...external.providerOutputSchemaObserved === true ? {
        providerOutputSchemaObserved: true,
        providerOutputSchemaDigest: external.providerOutputSchemaDigest ?? null
      } : {}
    } : {},
    invokePortId: manifest.invokePortId,
    argumentCompiler: { ...manifest.argumentCompiler }
  };
}
function manifestHasCompatibleAttestedReconcile(manifest) {
  if (!manifest.reconciliation.supported || manifest.reconciliation.policy !== "exact_artifact" || !manifest.reconcilePortId || manifest.reconcilePortId === manifest.invokePortId) return false;
  return manifest.providerKind === "local_registry" || manifest.providerKind === "composio" && manifest.operationId === BETA_PROVIDER_OPERATIONS.create && manifest.purpose === "persist_collection";
}
function reconcileForSealedManifest(manifest) {
  const supported = manifest.reconciliation.supported;
  const policy2 = manifest.reconciliation.policy;
  const accountId = manifest.accountId;
  const operationId = manifest.operationId === BETA_PROVIDER_OPERATIONS.create ? SHEET_RECONCILE : manifest.operationId;
  const expectedTransport = () => Object.freeze(attestedExpectationForManifest(manifest));
  return async ({ artifactId, intendedDigest }) => {
    if (!supported || policy2 === "uncertain_if_absent" || !manifestHasCompatibleAttestedReconcile(manifest)) {
      return { exists: false };
    }
    const id = artifactId?.trim() || "";
    if (!id || looksLikeContentDigest(id)) return { exists: false };
    const hostStorage = manifest.providerKind === "local_registry" && manifest.effect === "local_write" ? peekHostLocalWriteCarrier()?.select({ operationId: manifest.operationId, accountId }) ?? null : null;
    if (hostStorage) {
      const recovered = await hostStorage.reconcile({
        artifactId: id,
        accountId,
        operationId: manifest.operationId,
        expected: expectedTransport()
      });
      if (!recovered.exists || recovered.artifactId !== id || !recovered.handle || !recovered.receipt || recovered.contentDigest !== intendedDigest) return { exists: false };
      return {
        exists: true,
        id: recovered.artifactId,
        handle: recovered.handle,
        receipt: recovered.receipt,
        contentDigest: recovered.contentDigest
      };
    }
    const attested = (() => {
      try {
        return requireAttestedTransport();
      } catch {
        return null;
      }
    })();
    if (!attested) return { exists: false };
    const result = await attested.reconcile({
      artifactId: id,
      accountId,
      operationId
    });
    if (!result.exists || result.artifactId !== id) return { exists: false };
    return {
      exists: true,
      id: result.artifactId,
      handle: result.handle,
      receipt: result.receipt,
      ...result.contentDigest ? { contentDigest: result.contentDigest } : {}
    };
  };
}
var SHEET_CREATE, SHEET_READBACK, SHEET_RECONCILE, BETA_PROVIDER_OPERATIONS;
var init_production_capability_adapters = __esm({
  "src/runtime/harness/production-capability-adapters.ts"() {
    "use strict";
    init_composio_schema_cache();
    init_tool_contract_store();
    init_capability_live_identity();
    init_capability_manifest();
    init_isolated_test_contract();
    init_attested_transport();
    init_host_local_write_carrier();
    SHEET_CREATE = "GOOGLESHEETS_SHEET_FROM_JSON";
    SHEET_READBACK = "GOOGLESHEETS_BATCH_GET";
    SHEET_RECONCILE = "GOOGLESHEETS_GET_SPREADSHEET_INFO";
    BETA_PROVIDER_OPERATIONS = {
      locator: "TAVILY_TAVILY_SEARCH",
      collection: "TAVILY_TAVILY_EXTRACT",
      transform: "host_transform",
      create: SHEET_CREATE,
      readback: SHEET_READBACK,
      calendar: "GOOGLECALENDAR_CREATE_EVENT"
    };
  }
});

// src/runtime/harness/implementation-artifacts/reconcile-entry.ts
var reconcile_entry_exports = {};
__export(reconcile_entry_exports, {
  bindAttestedTransport: () => bindAttestedTransport,
  bindHostLocalWriteCarrier: () => bindHostLocalWriteCarrier,
  reconcileForSealedManifest: () => reconcileForSealedManifest
});
module.exports = __toCommonJS(reconcile_entry_exports);
init_production_capability_adapters();
init_attested_transport();
init_host_local_write_carrier();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bindAttestedTransport,
  bindHostLocalWriteCarrier,
  reconcileForSealedManifest
});
