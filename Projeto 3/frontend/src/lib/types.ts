export type Role = 'GERENTE' | 'ESTOQUISTA';
export type StockStatus = 'ZERADO' | 'BAIXO' | 'OK';
export type MovementType = 'ENTRADA' | 'SAIDA';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: User;
}

export interface Balance {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  unit: string;
  currentStock: number;
  safetyStock: number;
  status: StockStatus;
}

export interface AlertItem extends Balance {
  shortfall: number;
  preferredSupplier: string | null;
}

export interface AlertsResponse {
  data: AlertItem[];
  summary: { zerado: number; baixo: number; total: number };
}

export interface Movement {
  id: number;
  createdAt: string;
  productId: string;
  sku: string;
  productName: string;
  type: MovementType;
  reason: string;
  quantity: number;
  signedQuantity: number;
  balanceBefore: number;
  balanceAfter: number;
  /** Só vem preenchido para o perfil GERENTE. */
  unitCost?: number | null;
  documentRef: string | null;
  notes: string | null;
  reversalOfId: number | null;
  reversedById: number | null;
  userName: string;
  supplierName: string | null;
}

export interface Page<T> {
  data: T[];
  limit: number;
  offset: number;
}

export interface NewMovement {
  productId?: string;
  barcode?: string;
  sku?: string;
  type: MovementType;
  reason?: string;
  quantity: number;
  unitCost?: number;
  documentRef?: string;
  notes?: string;
}
