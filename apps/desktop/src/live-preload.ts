import { contextBridge, ipcRenderer } from 'electron';

export interface ClementineLiveResizeRequest {
  width: number;
  height: number;
  presentation: 'dormant' | 'panel';
  layoutId: number;
}

export interface ClementineLiveMountAck {
  generation: number;
  nonce: string;
}

export type ClementineLivePreviewListener = (payload: unknown) => void;
export type ClementineLiveMeetingListener = (payload: unknown) => void;
export type ClementineLiveLocalMeetingListener = (payload: unknown) => void;

const clementineLive = Object.freeze({
  resize: (bounds: ClementineLiveResizeRequest): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-resize', bounds)
  ),
  mounted: (mount: ClementineLiveMountAck): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-mounted', mount)
  ),
  openConsole: (): Promise<unknown> => ipcRenderer.invoke('clemmy:live-open-console'),
  dismiss: (): Promise<unknown> => ipcRenderer.invoke('clemmy:live-dismiss'),
  meetingStatus: (): Promise<unknown> => ipcRenderer.invoke('clemmy:live-meeting-status'),
  recordDetectedMeeting: (windowId: string): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-meeting-record', { windowId })
  ),
  alwaysRecordMeeting: (windowId: string): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-meeting-always-record', { windowId })
  ),
  dismissMeetingPrompt: (windowId: string): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-meeting-dismiss', { windowId })
  ),
  stopMeetingRecording: (windowId: string): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-meeting-stop', { windowId })
  ),
  requestMeetingPermissions: (): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-meeting-request-permissions')
  ),
  localMeetingStart: (payload?: { title?: string }): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-local-meeting-start', payload ?? {})
  ),
  localMeetingAppend: (sessionId: string, chunk: ArrayBuffer): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-local-meeting-append', { sessionId, chunk })
  ),
  localMeetingStop: (sessionId: string): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-local-meeting-stop', { sessionId })
  ),
  localMeetingCancel: (sessionId: string): Promise<unknown> => (
    ipcRenderer.invoke('clemmy:live-local-meeting-cancel', { sessionId })
  ),
  onPreview: (callback: ClementineLivePreviewListener): (() => void) => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on('clemmy:live-preview', listener);
    return () => ipcRenderer.removeListener('clemmy:live-preview', listener);
  },
  onMeetingEvent: (callback: ClementineLiveMeetingListener): (() => void) => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on('clemmy:live-meeting-event', listener);
    return () => ipcRenderer.removeListener('clemmy:live-meeting-event', listener);
  },
  onLocalMeetingEvent: (callback: ClementineLiveLocalMeetingListener): (() => void) => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on('clemmy:live-local-meeting-event', listener);
    return () => ipcRenderer.removeListener('clemmy:live-local-meeting-event', listener);
  },
});

contextBridge.exposeInMainWorld('clementineLive', clementineLive);

export type ClementineLiveDesktopApi = typeof clementineLive;
