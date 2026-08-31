export function liveProofSetupCommand(command: string, allowInstallScripts: boolean): string {
  // Repository live_test setup is maintainer-authored. Its direct package
  // manager installs are rewritten so a dependency lockfile bump cannot run a
  // postinstall that was never visible in the reviewed diff.
  const install = /^(\s*(?:pnpm|bun)\s+(?:install|i)\b|\s*npm\s+(?:install|i|ci)\b)/.exec(command);
  if (!install || allowInstallScripts) return command;
  if (/(?:^|\s)--(?:no-ignore-scripts|ignore-scripts=(?:false|0)|trust)(?:\s|$)/.test(command)) {
    throw new Error(
      "live_test.setup cannot enable install scripts without allow_install_scripts: true",
    );
  }
  if (/(?:^|\s)--ignore-scripts(?:=true)?(?:\s|$)/.test(command)) return command;
  return command.replace(install[0], `${install[0]} --ignore-scripts`);
}
