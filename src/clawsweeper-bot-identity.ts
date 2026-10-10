// The GitHub logins ClawSweeper writes as. The dashboard Worker and workflow
// steps run this file from source, so it has no imports.

// The ClawSweeper App slug. GraphQL reports the App bot login without the
// "[bot]" suffix.
export const CLAWSWEEPER_APP_SLUG = "clawsweeper";
// The REST `user.login` of the ClawSweeper App bot.
export const CLAWSWEEPER_APP_LOGIN = `${CLAWSWEEPER_APP_SLUG}[bot]`;

// The REST `user.login` values of the Apps ClawSweeper writes as. A REST login
// of bare "clawsweeper" is a user account, so it is not in this set.
export const CLAWSWEEPER_APP_BOT_LOGINS: ReadonlySet<string> = new Set([
  CLAWSWEEPER_APP_LOGIN,
  "openclaw-clawsweeper[bot]",
]);
// Every author login ClawSweeper writes as, including the GraphQL form.
export const CLAWSWEEPER_BOT_LOGINS: ReadonlySet<string> = new Set([
  CLAWSWEEPER_APP_SLUG,
  ...CLAWSWEEPER_APP_BOT_LOGINS,
]);
