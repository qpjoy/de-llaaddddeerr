/// <reference lib="dom" />
/** Upgrade single selects. Native values, validation and input/change events remain available. */
export declare function installNeonSelects(root?: Document | HTMLElement): {
  refresh(): void;
  destroy(): void;
};
