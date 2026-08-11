import fs from "node:fs";
import path from "node:path";

type SearchRoot = {
  path: string;
  ancestorRealPaths: Set<string>;
};

export function findFilesByBasenameSync(root: string, basename: string): string[] {
  const absoluteRoot = path.resolve(root);
  const roots: SearchRoot[] = [
    { path: absoluteRoot, ancestorRealPaths: new Set([fs.realpathSync(absoluteRoot)]) },
  ];
  const matches: string[] = [];

  for (const searchRoot of roots) {
    for (const entry of fs.globSync("**", { cwd: searchRoot.path, withFileTypes: true })) {
      const candidate = path.join(entry.parentPath, entry.name);
      if (entry.name === basename && fs.statSync(candidate).isFile()) matches.push(candidate);
      if (!entry.isSymbolicLink()) continue;
      let target: fs.Stats;
      try {
        target = fs.statSync(candidate);
      } catch {
        // Recursive readdir ignored unrelated broken symlinks.
        continue;
      }
      if (!target.isDirectory()) continue;

      // Recursive readdir followed directory symlinks; glob does not, so queue
      // each logical link while preventing cycles through its current ancestry.
      const realPath = fs.realpathSync(candidate);
      if (searchRoot.ancestorRealPaths.has(realPath)) continue;
      roots.push({
        path: candidate,
        ancestorRealPaths: new Set([...searchRoot.ancestorRealPaths, realPath]),
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
