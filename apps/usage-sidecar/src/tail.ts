import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface TailState {
  offset: number;
  carry: string;
}

export function emptyTail(): TailState {
  return { offset: 0, carry: '' };
}

export function primeToEnd(filePath: string): TailState {
  try {
    return { offset: statSync(filePath).size, carry: '' };
  } catch {
    return emptyTail();
  }
}

/** Read newly appended complete lines. Leaves a partial trailing line in carry. */
export function readNewLines(filePath: string, state: TailState): { lines: string[]; state: TailState } {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return { lines: [], state };
  }
  if (size < state.offset) {
    state = emptyTail();
  }
  if (size === state.offset) return { lines: [], state };
  const length = size - state.offset;
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, length, state.offset);
  } finally {
    closeSync(fd);
  }
  const text = state.carry + buf.toString('utf8');
  const parts = text.split('\n');
  const carry = parts.pop() ?? '';
  const lines = parts.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return { lines, state: { offset: size, carry } };
}

export function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
