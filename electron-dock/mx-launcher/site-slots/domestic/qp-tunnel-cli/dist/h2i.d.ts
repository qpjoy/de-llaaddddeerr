interface H2iCliContext {
    isRoot(): boolean;
    sudoSelf(args: string[]): never;
}
export declare function runH2iCli(args: string[], ctx: H2iCliContext): Promise<void>;
export {};
