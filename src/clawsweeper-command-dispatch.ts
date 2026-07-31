import { UserFacingCommandError } from "./command.js";

export type CommandHandler<Args> = (args: Args) => void | Promise<void>;

export async function dispatchCommand<Args>(
  command: string,
  args: Args,
  handlers: Readonly<Record<string, CommandHandler<Args>>>,
): Promise<void> {
  if (!Object.hasOwn(handlers, command)) {
    throw new UserFacingCommandError(`Unknown command: ${command}`);
  }
  const handler = handlers[command];
  if (!handler) throw new UserFacingCommandError(`Unknown command: ${command}`);
  await handler(args);
}
