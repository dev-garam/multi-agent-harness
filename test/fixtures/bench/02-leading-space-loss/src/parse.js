// Status lines are fixed-width: two status characters, one space, then the path.
//   " M README.md"   -> status "M",  path "README.md"
//   "?? .env"        -> status "??", path ".env"
export function parseStatusLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3)
    }));
}
