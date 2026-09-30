import { maximumRepositoryGitConfigOutputBytes } from "./repository-git-filters.js"

// A Git config file with enough filter sections that the reader's
// `git config --show-scope --show-origin -z` output passes its cap on every
// platform: each record counts the scope, the including file's path as Git
// prints it, the key and the value, so a short path on one machine needs more
// sections than a long one on another. A quarter over the cap leaves margin.
export function overflowingFilterConfig(includedPath: string): string {
  const sections: string[] = []
  let bytes = 0
  for (let index = 0; bytes <= maximumRepositoryGitConfigOutputBytes * 1.25; index += 1) {
    const key = `filter.f${index}.smudge`
    // scope NUL "file:" path NUL key LF value NUL
    bytes += "local".length + "file:".length + includedPath.length + key.length + "cat".length + 4
    sections.push(`[filter "f${index}"]\n\tsmudge = cat\n`)
  }
  return sections.join("")
}
