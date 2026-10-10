import {
  CLAWSWEEPER_APP_LOGIN,
  CLAWSWEEPER_APP_NOREPLY_EMAIL,
} from "../clawsweeper-bot-identity.js";

export const CLAWSWEEPER_CO_AUTHOR = {
  name: CLAWSWEEPER_APP_LOGIN,
  email: CLAWSWEEPER_APP_NOREPLY_EMAIL,
} as const;

export const CLAWSWEEPER_CO_AUTHOR_TRAILER = `Co-authored-by: ${CLAWSWEEPER_CO_AUTHOR.name} <${CLAWSWEEPER_CO_AUTHOR.email}>`;

export function coAuthorKey(name: string, email: string) {
  return `${name.trim().toLowerCase()} <${email.trim().toLowerCase()}>`;
}

export function clawsweeperCoAuthorKey() {
  return coAuthorKey(CLAWSWEEPER_CO_AUTHOR.name, CLAWSWEEPER_CO_AUTHOR.email);
}
