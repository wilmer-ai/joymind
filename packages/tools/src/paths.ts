import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.js';

interface ResolveOptions {
  allowMissing?: boolean;
  allowWorkspaceRoot?: boolean;
}

function denied(requestedPath: string): ToolError {
  return new ToolError('permission_denied', `Path escapes the workspace: ${requestedPath}`, {
    details: { path: requestedPath },
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateRelativePath(requestedPath: string): void {
  if (
    requestedPath.includes('\0')
    || path.posix.isAbsolute(requestedPath)
    || path.win32.isAbsolute(requestedPath)
    || /^[a-zA-Z]:/.test(requestedPath)
    || requestedPath.split(/[\\/]/).includes('..')
  ) {
    throw denied(requestedPath);
  }
}

export async function resolveWorkspacePath(
  workspacePath: string,
  requestedPath: string,
  options: ResolveOptions = {},
): Promise<string> {
  validateRelativePath(requestedPath);
  const workspace = await realpath(workspacePath);
  if (!(await stat(workspace)).isDirectory()) {
    throw new ToolError('tool_error', 'Workspace path is not a directory');
  }

  const candidate = path.resolve(workspace, requestedPath);
  if (!isWithin(workspace, candidate)) throw denied(requestedPath);

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (!options.allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if ((await lstat(candidate)).isSymbolicLink()) throw denied(requestedPath);
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') throw lstatError;
    }
    const parent = await realpath(path.dirname(candidate));
    if (!isWithin(workspace, parent)) throw denied(requestedPath);
    resolved = path.join(parent, path.basename(candidate));
  }

  if (!isWithin(workspace, resolved)) throw denied(requestedPath);
  if (!options.allowWorkspaceRoot && resolved === workspace) {
    throw new ToolError('permission_denied', 'The workspace root is not a valid target for this operation', {
      details: { path: requestedPath },
    });
  }
  return resolved;
}
