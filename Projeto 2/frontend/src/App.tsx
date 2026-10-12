import { useCallback, useState } from 'react';
import Login from './components/Login';
import StockDashboard from './components/StockDashboard';

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('stock_token'));
  const login = useCallback((value: string) => { sessionStorage.setItem('stock_token', value); setToken(value); }, []);
  const logout = useCallback(() => { sessionStorage.removeItem('stock_token'); setToken(null); }, []);
  return token ? <StockDashboard token={token} onLogout={logout} /> : <Login onLogin={login} />;
}
