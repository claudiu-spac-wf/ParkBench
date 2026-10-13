export interface CommandResult {
  commandId: string;
  accepted: boolean;
}
export class CommandRegistry {
  private completed = new Map<string, CommandResult>();
  execute(commandId: string, action: () => void): CommandResult {
    const existing = this.completed.get(commandId);
    if (existing) return existing;
    const result = { commandId, accepted: true };
    action();
    this.completed.set(commandId, result);
    return result;
  }
}
