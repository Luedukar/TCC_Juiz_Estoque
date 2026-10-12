export interface LowStockProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  quantity: number | string;
  safety_stock: number | string;
}

export interface ApiEnvelope<T> {
  data: T;
}

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: {
    id: string;
    name: string;
    email: string;
    role: 'manager' | 'stockist';
  };
}
