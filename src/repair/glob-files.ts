import fs from "node:fs";
import path from "node:path";

type SearchRoot = {
  path: string;
  ancestorRealPaths: Set<string>;
};

export function findFilesByBasenameSync(root: string, basename: string): string[] {
  const absoluteRoot = path.resolve(root);
  const directories: SearchRoot[] = [
    { path: absoluteRoot, ancestorRealPaths: new Set([fs.realpathSync(absoluteRoot)]) },
  ];
  const matches: string[] = [];

  for (const directory of directories) {
    // globSync treats unreadable directories as empty, unlike recursive readdir.
    fs.readdirSync(directory.path);
    for (const entry of fs.globSync(["*", ".*"], {
      cwd: directory.path,
      withFileTypes: true,
    })) {
      const candidate = path.join(entry.parentPath, entry.name);
      if (entry.name === basename && fs.statSync(candidate).isFile()) matches.push(candidate);
      // Direct globbing exposes symlink Dirents without following them; stat
      // preserves recursive readdir's directory-link traversal contract.
      let target: fs.Stats;
      try {
        target = fs.statSync(candidate);
      } catch {
        // Recursive readdir ignored unrelated broken symlinks.
        continue;
      }
      if (!target.isDirectory()) continue;

      const realPath = fs.realpathSync(candidate);
      if (directory.ancestorRealPaths.has(realPath)) continue;
      directories.push({
        path: candidate,
        ancestorRealPaths: new Set([...directory.ancestorRealPaths, realPath]),
      });
    }
  }

  return matches.sort((left, right) => recursiveEntryCompare(absoluteRoot, left, right));
}

function recursiveEntryCompare(root: string, left: string, right: string): number {
  const leftRelative = path.relative(root, left);
  const rightRelative = path.relative(root, right);
  const depthDifference = pathDepth(leftRelative) - pathDepth(rightRelative);
  if (depthDifference !== 0) return depthDifference;
  return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
}

function pathDepth(relativePath: string): number {
  return relativePath.split(path.sep).length;
}
