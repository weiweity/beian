import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const STALE = 'worktrees/beian-r04-resource-stress';

export function isExecutedDirectly(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

export function parseRepoOut(argv, env = {}) {
  const repoArg = argv[2];
  const outArg = argv[3];
  if (!repoArg || !String(repoArg).trim() || !outArg || !String(outArg).trim()) {
    const error = new Error('usage: node <probe.mjs> <repo> <out>');
    error.code = 'USAGE';
    throw error;
  }
  if (String(repoArg).includes(STALE)) {
    const error = new Error('refuse: stale worktree path in repo argv');
    error.code = 'STALE';
    throw error;
  }
  return {repo: resolve(repoArg), out: resolve(outArg), env};
}
