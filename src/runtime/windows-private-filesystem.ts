import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asciiJson } from './ascii-json.js';

/** This program receives data on stdin, never interpolated PowerShell source.
 * The ACL is read/set on an identity-checked handle without delete sharing.
 * Opening a reparse point never follows it, and the final canonical path must
 * match before changing permissions. Only dedicated host stores call harden.
 */
export const WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE = String.raw`
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

const ACL_PROGRAM = String.raw`
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

export interface PrivateFilesystemIdentity {
  dev: number | bigint;
  ino: number | bigint;
  nlink: number | bigint;
}

export class WindowsPrivateFilesystemError extends Error {
  constructor(cause?: unknown) {
    super('Windows private filesystem ACL could not be verified. Check NTFS folder access and the Clementine native helper installation, then retry. Development fallback also requires PowerShell access.', cause === undefined ? undefined : { cause });
    this.name = 'WindowsPrivateFilesystemError';
  }
}

export interface WindowsPrivateFilesystemReceipt {
  backend: 'native' | 'powershell-development';
  policy: 'strict' | 'credential-inherited-private-v1';
}

/** The native probe is an owned build artifact, never resolved from PATH or
 * user settings. Desktop bundles keep this same resolver and canonical class. */
export function windowsPrivateFilesystemProbeLocation(): { directory: string; packaged: boolean } {
  const filename = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
  const directory = path.dirname(filename);
  const packageRoot = path.resolve(directory, '../..');
  if (path.basename(packageRoot).toLowerCase() === 'daemon') {
    return { directory: path.join(path.dirname(packageRoot), 'windows-private-filesystem'), packaged: true };
  }
  const asarIndex = filename.toLowerCase().indexOf(`${path.sep}app.asar${path.sep}`);
  if (asarIndex >= 0) {
    const resources = filename.slice(0, asarIndex);
    if (!path.isAbsolute(resources)) throw new WindowsPrivateFilesystemError();
    return { directory: path.join(resources, 'windows-private-filesystem'), packaged: true };
  }
  const repoRoot = path.basename(path.dirname(directory)) === 'desktop'
    ? path.resolve(directory, '../../..') : packageRoot;
  return { directory: path.join(repoRoot, 'output', 'windows-private-filesystem'), packaged: false };
}

export function windowsPrivateFilesystemClassSourceSha256(): string {
  return createHash('sha256').update(WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE).digest('hex');
}

function readStableBuildArtifact(target: string): Buffer {
  const before = lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino === 0n || before.size > 16n * 1024n * 1024n) throw new WindowsPrivateFilesystemError();
  const bytes = readFileSync(target);
  const after = lstatSync(target, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink
    || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new WindowsPrivateFilesystemError();
  return bytes;
}

function qualifiedNativeProbe(): string | null {
  const location = windowsPrivateFilesystemProbeLocation();
  const probe = path.join(location.directory, 'windows-private-filesystem-probe.exe');
  const manifestFile = path.join(location.directory, 'manifest.json');
  if (!existsSync(probe) && !existsSync(manifestFile) && !location.packaged) return null;
  try {
    const manifest = JSON.parse(readStableBuildArtifact(manifestFile).toString('utf8')) as Record<string, unknown>;
    if (manifest.version !== 2 || manifest.classSourceSha256 !== windowsPrivateFilesystemClassSourceSha256()
      || typeof manifest.probeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.probeSha256)) throw new WindowsPrivateFilesystemError();
    if (createHash('sha256').update(readStableBuildArtifact(probe)).digest('hex') !== manifest.probeSha256) throw new WindowsPrivateFilesystemError();
    return probe;
  } catch (cause) { throw new WindowsPrivateFilesystemError(cause); }
}

/** No permission caching: every retained read is checked against the current ACL. */
export function assertWindowsPrivateFilesystem(
  target: string,
  identity: PrivateFilesystemIdentity,
  kind: 'file' | 'directory',
  harden = false,
  options: { allowInheritedPrivate?: boolean } = {},
): WindowsPrivateFilesystemReceipt {
  if (process.platform !== 'win32') throw new Error('Windows private ACL verification called on another platform');
  if (!path.isAbsolute(target) || target.length > 16000 || /\0/.test(target)) throw new Error('private ACL target is invalid');
  const syntheticHome = process.env.CLEMENTINE_HOME ?? '';
  const relative = path.relative(syntheticHome, target);
  const syntheticDiagnostic = process.env.CLEMMY_TEST_ISOLATED_HOME === '1'
    && process.env.CLEMMY_TEST_PRIVATE_ACL_DIAGNOSTICS === '1'
    && /^clem-private-ntfs-test-/.test(path.basename(syntheticHome))
    && !relative.startsWith('..') && !path.isAbsolute(relative);
  const allowInheritedPrivate = !harden && options.allowInheritedPrivate === true;
  const input = asciiJson({ version: 2, path: target, dev: String(identity.dev), ino: String(identity.ino), nlink: String(identity.nlink), directory: kind === 'directory', harden, allowInheritedPrivate, syntheticDiagnostic });
  const native = qualifiedNativeProbe();
  const systemRoot = Object.entries(process.env).find(([key, value]) => key.toLowerCase() === 'systemroot' && value)?.[1] ?? 'C:\\Windows';
  if (!path.isAbsolute(systemRoot)) throw new WindowsPrivateFilesystemError();
  const command = native ?? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = native ? [] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_PROGRAM, 'utf16le').toString('base64')];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && /^(?:systemroot|windir|systemdrive|comspec|pathext|temp|tmp)$/i.test(key)));
  const result = spawnSync(command, args, { input, env, encoding: 'utf8', windowsHide: true,
    timeout: native ? 2_000 : 10_000, maxBuffer: 4096 });
  if (result.error || result.status !== 0 || result.stdout !== 'private-acl-ok-v2') {
    throw new WindowsPrivateFilesystemError(syntheticDiagnostic ? String(result.stderr || result.error?.message || 'no ACL receipt').slice(0, 4096) : undefined);
  }
  return { backend: native ? 'native' : 'powershell-development', policy: allowInheritedPrivate ? 'credential-inherited-private-v1' : 'strict' };
}
