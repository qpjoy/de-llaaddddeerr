export {
  neonVoidCssVariables,
  neonVoidLightCssVariables,
  neonVoidLightTheme,
  neonVoidTokens,
  neonVoidTheme,
  type NeonVoidTokens,
  type TokenLeaf
} from './tokens.js';

export const packageName = '@qpjoy/ui-design-neon-void';
export const styleName = 'neon-void';

export const cssEntryPoints = {
  styles: '@qpjoy/ui-design-neon-void/styles.css',
  tokens: '@qpjoy/ui-design-neon-void/tokens.css'
} as const;

export const classNames = {
  app: 'qp-app qp-theme-neon-void',
  appLight: 'qp-app qp-theme-neon-void-light',
  densitySmall: 'qp-density--small',
  densityMedium: 'qp-density--medium',
  densityLarge: 'qp-density--large',
  sectionTitle: 'qp-section-title',
  panel: 'qp-panel',
  card: 'qp-card',
  button: 'qp-button',
  buttonPrimary: 'qp-button qp-button--primary',
  buttonOutline: 'qp-button qp-button--outline',
  buttonGhost: 'qp-button qp-button--ghost',
  buttonDanger: 'qp-button qp-button--danger',
  input: 'qp-input',
  select: 'qp-select',
  dropdown: 'qp-dropdown',
  field: 'qp-field',
  checkbox: 'qp-choice qp-choice--checkbox',
  radio: 'qp-choice qp-choice--radio',
  switch: 'qp-switch',
  tag: 'qp-tag',
  menu: 'qp-menu',
  toast: 'qp-toast',
  modalBackdrop: 'qp-modal-backdrop',
  modal: 'qp-modal qp-modal--medium',
  modalSmall: 'qp-modal qp-modal--small',
  modalLarge: 'qp-modal qp-modal--large',
  modalXLarge: 'qp-modal qp-modal--xlarge',
  dialog: 'qp-dialog',
  dialogDanger: 'qp-dialog qp-dialog--danger',
  pagination: 'qp-pagination',
  projectCard: 'qp-project-card',
  userCard: 'qp-user-card',
  settingsView: 'qp-settings-view',
  propertiesPanel: 'qp-properties-panel',
  splitPanel: 'qp-split-panel',
  anchorGrid: 'qp-anchor-grid',
  iconBoard: 'qp-icon-board'
} as const;
