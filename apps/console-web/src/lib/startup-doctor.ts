import { apiGet } from './api';

export type StartupDoctorStatus = 'ok' | 'warning' | 'error';

export interface StartupDoctorIssue {
  id: string;
  severity: Exclude<StartupDoctorStatus, 'ok'>;
  title: string;
  detail: string;
  fix?: string;
  command?: string;
}

export interface StartupRuntimeSnapshot {
  node: string;
  nodeModuleVersion: string;
  platform: string;
  arch: string;
  electron?: string | null;
  pid: number;
  cwd: string;
  execPath: string;
}

export interface StartupPackageSnapshot {
  name: string;
  version: string;
  engineNode?: string;
  packagePath?: string;
  electronVersion?: string;
}

export interface NativeDependencyCheck {
  name: string;
  declared: boolean;
  installed: boolean;
  loaded: boolean;
  status: StartupDoctorStatus;
  version?: string;
  resolvedPath?: string;
  message: string;
  issue?: StartupDoctorIssue;
}

export interface StartupDoctor {
  generatedAt: string;
  status: StartupDoctorStatus;
  runtime: StartupRuntimeSnapshot;
  package: StartupPackageSnapshot;
  nativeDependencies: NativeDependencyCheck[];
  issues: StartupDoctorIssue[];
  recommendations: string[];
}

export const getStartupDoctor = () =>
  apiGet<StartupDoctor>('/api/console/startup-doctor');
