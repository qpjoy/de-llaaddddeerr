export type MxServiceCommand =
  | 'install-wireguard'
  | 'apply-wireguard-profile'
  | 'apply-nrpt'
  | 'apply-dns'
  | 'apply-routes'
  | 'disconnect'
  | 'diagnose';

export interface MxServiceRequest {
  id: string;
  command: MxServiceCommand;
  productId: string;
  payload: Record<string, unknown>;
}

export interface MxServiceResponse {
  id: string;
  ok: boolean;
  error: string | null;
  diagnostics: Record<string, unknown> | null;
}
