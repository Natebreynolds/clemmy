/** Keep a useful conversation width before admitting either secondary pane. */
export function agentWorkspaceLayout(width: number, threads = true, about = true) {
  const center = 520;
  const inlineThreads = threads && width >= center + 260;
  const inlineAbout = about && width >= center + (inlineThreads ? 260 : 0) + 320;
  return { inlineThreads, inlineAbout };
}
