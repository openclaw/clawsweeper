export function normalizeRepo(targetRepo: string): string {
  return targetRepo.trim().toLowerCase();
}

export function slugForRepo(targetRepo: string): string {
  return targetRepo.replace(/[^A-Za-z0-9_.-]+/g, "-");
}
