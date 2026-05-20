export const CLAWSWEEPER_CO_AUTHOR = {
  name: "clawsweeper[bot]",
  email: "274271284+clawsweeper[bot]@users.noreply.github.com",
} as const;

export const CLAWSWEEPER_CO_AUTHOR_TRAILER = `Co-authored-by: ${CLAWSWEEPER_CO_AUTHOR.name} <${CLAWSWEEPER_CO_AUTHOR.email}>`;

export function coAuthorKey(name: string, email: string) {
  return `${name.trim().toLowerCase()} <${email.trim().toLowerCase()}>`;
}

export function clawsweeperCoAuthorKey() {
  return coAuthorKey(CLAWSWEEPER_CO_AUTHOR.name, CLAWSWEEPER_CO_AUTHOR.email);
}
