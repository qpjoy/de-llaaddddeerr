export interface WgCliContext {
    isRoot: () => boolean;
    sudoSelf: (cliArgs: string[]) => never;
}
export declare function runWgCli(args: string[], ctx: WgCliContext): Promise<void>;
