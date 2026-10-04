export function importZeroFilesMessage(searchedPath: string): string {
  return `No JSONL files were imported from ${searchedPath}. Check the path, or pass a directory that contains session .jsonl files.`;
}
