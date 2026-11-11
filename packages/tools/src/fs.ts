import { open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '@joymind/core';
import { approvalRequired, ToolError } from './errors.js';
import { resolveWorkspacePath } from './paths.js';

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

const readInput = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(256 * 1024),
}).strict();
const listInput = z.object({
  path: z.string().min(1).default('.'),
  maxEntries: z.number().int().min(1).max(1000).default(200),
}).strict();
const searchInput = z.object({
  query: z.string().min(1).max(1000),
  path: z.string().min(1).default('.'),
  caseSensitive: z.boolean().default(true),
  maxResults: z.number().int().min(1).max(200).default(100),
  maxFileBytes: z.number().int().min(1).max(MAX_SEARCH_FILE_BYTES).default(256 * 1024),
  maxFiles: z.number().int().min(1).max(10_000).default(1000),
}).strict();
const writeInput = z.object({
  path: z.string().min(1),
  content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_WRITE_BYTES, {
    message: `Content must not exceed ${MAX_WRITE_BYTES} UTF-8 bytes`,
  }),
}).strict();
const deleteInput = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
}).strict();

const readOutput = z.object({
  path: z.string(), content: z.string(), size: z.number(), truncated: z.boolean(),
});
const listOutput = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'symlink', 'other']) })),
  truncated: z.boolean(),
});
const searchOutput = z.object({
  matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
  filesSearched: z.number(),
  truncated: z.boolean(),
});
const writeOutput = z.object({ path: z.string(), bytesWritten: z.number(), diff: z.string() });
const deleteOutput = z.object({ path: z.string(), recursive: z.boolean() });

type ReadInput = z.infer<typeof readInput>;
type ListInput = z.infer<typeof listInput>;
type SearchInput = z.infer<typeof searchInput>;
type WriteInput = z.infer<typeof writeInput>;
type DeleteInput = z.infer<typeof deleteInput>;

function modelSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-07' });
}

function containsBinaryData(content: Buffer): boolean {
  return content.includes(0);
}

async function readLimited(filePath: string, maxBytes: number): Promise<{ content: Buffer; size: number; truncated: boolean }> {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new ToolError('tool_error', `Not a regular file: ${filePath}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, maxBytes)),
      size: fileStat.size,
      truncated: bytesRead > maxBytes || fileStat.size > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

async function executeRead(input: ReadInput, context: ToolContext) {
  const resolved = await resolveWorkspacePath(context.workspacePath, input.path, { allowWorkspaceRoot: true });
  const result = await readLimited(resolved, input.maxBytes);
  if (containsBinaryData(result.content)) {
    throw new ToolError('tool_error', `Binary files are not supported: ${input.path}`);
  }
  return {
    path: input.path,
    content: result.content.toString('utf8'),
    size: result.size,
    truncated: result.truncated,
  };
}

async function executeList(input: ListInput, context: ToolContext) {
  const resolved = await resolveWorkspacePath(context.workspacePath, input.path, { allowWorkspaceRoot: true });
  const entries = await readdir(resolved, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const selected = entries.slice(0, input.maxEntries);
  return {
    path: input.path,
    entries: selected.map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : entry.isSymbolicLink() ? 'symlink' as const : 'other' as const,
    })),
    truncated: entries.length > selected.length,
  };
}

async function executeSearch(input: SearchInput, context: ToolContext) {
  const root = await resolveWorkspacePath(context.workspacePath, input.path, { allowWorkspaceRoot: true });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const pending = [root];
  let filesSearched = 0;
  const query = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();

  while (pending.length > 0 && matches.length < input.maxResults && filesSearched < input.maxFiles) {
    if (context.signal.aborted) throw new ToolError('cancelled', 'Search was cancelled');
    const current = pending.pop();
    if (current === undefined) break;
    const currentStat = await stat(current);
    if (currentStat.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry !== undefined && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
      }
      continue;
    }
    if (!currentStat.isFile() || currentStat.size > input.maxFileBytes) continue;
    filesSearched += 1;
    const file = await readFile(current);
    if (containsBinaryData(file)) continue;
    const lines = file.toString('utf8').split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length && matches.length < input.maxResults; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      const compared = input.caseSensitive ? line : line.toLocaleLowerCase();
      if (compared.includes(query)) {
        matches.push({
          path: path.relative(root, current) || path.basename(current),
          line: lineIndex + 1,
          text: line.length > 500 ? `${line.slice(0, 500)}…` : line,
        });
      }
    }
  }
  const truncated = matches.length >= input.maxResults || filesSearched >= input.maxFiles || pending.length > 0;
  return { matches, filesSearched, truncated };
}

async function prepareWrite(input: WriteInput, context: ToolContext) {
  const resolved = await resolveWorkspacePath(context.workspacePath, input.path, {
    allowMissing: true,
    allowWorkspaceRoot: false,
  });
  let previous = '';
  try {
    previous = await readFile(resolved, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { resolved, diff: createTwoFilesPatch(input.path, input.path, previous, input.content, '', '', { context: 3 }) };
}

async function previewWrite(input: WriteInput, context: ToolContext) {
  return { diff: (await prepareWrite(input, context)).diff };
}

async function executeWrite(input: WriteInput, context: ToolContext) {
  if (context.approved !== true) throw approvalRequired('fs.write');
  const { resolved, diff } = await prepareWrite(input, context);
  await writeFile(resolved, input.content, 'utf8');
  return { path: input.path, bytesWritten: Buffer.byteLength(input.content, 'utf8'), diff };
}

async function executeDelete(input: DeleteInput, context: ToolContext) {
  if (context.approved !== true) throw approvalRequired('fs.delete');
  const resolved = await resolveWorkspacePath(context.workspacePath, input.path, { allowWorkspaceRoot: false });
  await rm(resolved, { recursive: input.recursive, force: false });
  return { path: input.path, recursive: input.recursive };
}

export function createFileTools(): ToolDefinition[] {
  return [
    {
      name: 'fs.read', version: '0.1.0', description: 'Read a UTF-8 text file inside the workspace, with a byte limit.',
      inputSchema: readInput, outputSchema: readOutput, jsonSchema: modelSchema(readInput), risk: 'read',
      capabilities: ['filesystem:read'], idempotency: 'safe', execute: executeRead,
    },
    {
      name: 'fs.list', version: '0.1.0', description: 'List one directory inside the workspace without following symlinks.',
      inputSchema: listInput, outputSchema: listOutput, jsonSchema: modelSchema(listInput), risk: 'read',
      capabilities: ['filesystem:read'], idempotency: 'safe', execute: executeList,
    },
    {
      name: 'fs.search', version: '0.1.0', description: 'Search UTF-8 text below a workspace path with file, result, and size limits.',
      inputSchema: searchInput, outputSchema: searchOutput, jsonSchema: modelSchema(searchInput), risk: 'read',
      capabilities: ['filesystem:read', 'filesystem:search'], idempotency: 'safe', execute: executeSearch,
    },
    {
      name: 'fs.write', version: '0.1.0', description: 'Create or replace one UTF-8 workspace file after approval and return a unified diff.',
      inputSchema: writeInput, outputSchema: writeOutput, jsonSchema: modelSchema(writeInput), risk: 'write',
      capabilities: ['filesystem:read', 'filesystem:write'], idempotency: 'idempotent', preview: previewWrite, execute: executeWrite,
    },
    {
      name: 'fs.delete', version: '0.1.0', description: 'Delete a workspace file or directory after approval; recursion is opt-in.',
      inputSchema: deleteInput, outputSchema: deleteOutput, jsonSchema: modelSchema(deleteInput), risk: 'write',
      capabilities: ['filesystem:delete'], idempotency: 'idempotent', execute: executeDelete,
    },
  ];
}
