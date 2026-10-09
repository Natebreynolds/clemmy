/** Stable host facts, shared by every model and specialist. No user data,
 * remembered assumptions, credential source or permissions are inferred here. */
export function renderHostExecutionContext(platform: NodeJS.Platform = process.platform): string {
  // Without this the model writes GNU/Linux flags, which fail here and cost a
  // retry round.
  if (platform === 'darwin') return 'HOST EXECUTION — this connected computer runs macOS. run_shell_command runs /bin/sh with the BSD command-line tools, whose flags differ from GNU/Linux (for example `stat -f %z`, not `stat -c %s`). To find files by name, ask Spotlight (`mdfind -name <name>`, add `-onlyin <folder>` to narrow it), which answers at once; `find` across the home folder can take minutes.';
  if (platform !== 'win32') return '';
  return 'HOST EXECUTION — this connected computer runs Windows. run_shell_command uses cmd.exe syntax; PowerShell syntax requires explicitly invoking PowerShell. Use literal Windows paths and the tool\'s cwd for project/skill commands, including another drive, rather than assuming POSIX cd or shell syntax. Discover native executables with the available CLI tools; use the platform-specific setup result. Built-in computer tools operate on files, shell and Git; browser control does not imply arbitrary desktop mouse/keyboard control.';
}

export function shellCwdGuidance(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `${renderHostExecutionContext(platform)}\nCWD GUIDANCE: leave cwd null for commands that do not depend on project files. Set cwd to the existing allowed project or skill directory when file context is required. Do not use Mac TCC/Homebrew remedies for Windows failures.`;
  const shell = platform === 'darwin' ? `${renderHostExecutionContext(platform)}\n` : '';
  return shell + 'CWD GUIDANCE: leave `cwd` null unless you have a specific reason to be elsewhere. On macOS, paths under ~/Desktop, ~/Documents, ~/Downloads, and iCloud Drive are TCC-protected from sandboxed-app children: child Node CLIs (sf, npm, etc.) spawned there throw EPERM on getcwd. The default cwd (Clementine\'s base directory, which the daemon already has TCC access to) is safe and works for tool invocations that don\'t actually depend on file context (CLI calls, API queries, etc.). Pass an explicit `cwd` only when the command genuinely needs to run in a specific project directory configured in WORKSPACE_DIRS.';
}
