interface HdoCliContext {
    isRoot(): boolean;
    sudoSelf(args: string[]): never;
}
export declare function runHdoCli(args: string[], ctx: HdoCliContext): Promise<void>;
export {};
