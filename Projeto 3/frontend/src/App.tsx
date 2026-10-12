import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ServerDown } from './components/ServerDown';
import { useAuth } from './lib/AuthContext';
import Balances from './pages/Balances';
import Dashboard from './pages/Dashboard';
import Kardex from './pages/Kardex';
import Login from './pages/Login';
import Movement from './pages/Movement';

function Protected() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center text-ink-soft" role="status">
        Carregando…
      </div>
    );
  }
  if (status === 'unavailable') return <ServerDown />;
  if (status === 'anonymous') return <Navigate to="/entrar" state={{ from: location.pathname }} replace />;

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<Login />} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="movimentacao" element={<Movement />} />
        <Route path="saldos" element={<Balances />} />
        <Route path="kardex" element={<Kardex />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
