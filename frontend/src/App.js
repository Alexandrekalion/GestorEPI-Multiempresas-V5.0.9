import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import Login from '@/pages/Login';
import ChangePassword from '@/pages/ChangePassword';
import Dashboard from '@/pages/Dashboard';
import EntregaEPI from '@/pages/EntregaEPI';
import Colaboradores from '@/pages/Colaboradores';
import Empresas from '@/pages/Empresas';
import EPIs from '@/pages/EPIs';
import Kits from '@/pages/Kits';
import Estoque from '@/pages/Estoque';
import Usuarios from '@/pages/Usuarios';
import Configuracoes from '@/pages/Configuracoes';
import AtendentesBalcao from '@/pages/AtendentesBalcao';
import Fornecedores from '@/pages/Fornecedores';
import ColaboradorDetalhes from '@/pages/ColaboradorDetalhes';
import HistoricoEntregas from '@/pages/HistoricoEntregas';
import Relatorios from '@/pages/Relatorios';
import Alertas from '@/pages/Alertas';
import Cursos from '@/pages/Cursos';
import TesteFacialFase103 from '@/pages/TesteFacialFase103';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import '@/App.css';

const ROLE_ROUTES = {
  dashboard: ['admin', 'gestor', 'rh', 'seguranca_trabalho', 'almoxarifado'],
  entrega: ['admin', 'almoxarifado'],
  historico: ['admin', 'gestor', 'rh', 'seguranca_trabalho', 'almoxarifado'],
  relatorios: ['admin', 'gestor', 'rh', 'seguranca_trabalho', 'almoxarifado'],
  colaboradores: ['admin', 'gestor', 'rh', 'seguranca_trabalho', 'almoxarifado'],
  empresas: ['admin', 'gestor', 'seguranca_trabalho', 'almoxarifado'],
  epis: ['admin', 'gestor', 'almoxarifado'],
  kits: ['admin', 'gestor', 'seguranca_trabalho'],
  fornecedores: ['admin', 'gestor', 'seguranca_trabalho', 'almoxarifado'],
  estoque: ['admin', 'gestor', 'almoxarifado'],
  usuarios: ['admin', 'gestor'],
  configuracoes: ['admin'],
  atendentesBalcao: ['admin'],
  alertas: ['admin', 'gestor', 'rh', 'seguranca_trabalho', 'almoxarifado'],
  cursos: ['admin', 'gestor', 'seguranca_trabalho', 'almoxarifado'],
  testeFacialFase103: ['admin']
};

const PrivateRoute = ({ children, roles }) => {
  const { token, user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500"></div>
      </div>
    );
  }

  if (!token) return <Navigate to="/login" />;
  if (roles && !roles.includes(user?.role)) return <Navigate to="/dashboard" replace />;
  return children;
};

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<PrivateRoute><ChangePassword /></PrivateRoute>} />
      <Route path="/dashboard" element={<PrivateRoute roles={ROLE_ROUTES.dashboard}><Dashboard /></PrivateRoute>} />
      <Route path="/entrega-epi" element={<PrivateRoute roles={ROLE_ROUTES.entrega}><EntregaEPI /></PrivateRoute>} />
      <Route path="/relatorios" element={<PrivateRoute roles={ROLE_ROUTES.relatorios}><Relatorios /></PrivateRoute>} />
      <Route path="/historico-entregas" element={<PrivateRoute roles={ROLE_ROUTES.historico}><HistoricoEntregas /></PrivateRoute>} />
      <Route path="/colaboradores" element={<PrivateRoute roles={ROLE_ROUTES.colaboradores}><Colaboradores /></PrivateRoute>} />
      <Route path="/colaboradores/:id" element={<PrivateRoute roles={ROLE_ROUTES.colaboradores}><ColaboradorDetalhes /></PrivateRoute>} />
      <Route path="/empresas" element={<PrivateRoute roles={ROLE_ROUTES.empresas}><Empresas /></PrivateRoute>} />
      <Route path="/epis" element={<PrivateRoute roles={ROLE_ROUTES.epis}><EPIs /></PrivateRoute>} />
      <Route path="/kits" element={<PrivateRoute roles={ROLE_ROUTES.kits}><Kits /></PrivateRoute>} />
      <Route path="/estoque" element={<PrivateRoute roles={ROLE_ROUTES.estoque}><Estoque /></PrivateRoute>} />
      <Route path="/fornecedores" element={<PrivateRoute roles={ROLE_ROUTES.fornecedores}><Fornecedores /></PrivateRoute>} />
      <Route path="/usuarios" element={<PrivateRoute roles={ROLE_ROUTES.usuarios}><Usuarios /></PrivateRoute>} />
      <Route path="/configuracoes" element={<PrivateRoute roles={ROLE_ROUTES.configuracoes}><Configuracoes /></PrivateRoute>} />
      <Route path="/atendentes-balcao" element={<PrivateRoute roles={ROLE_ROUTES.atendentesBalcao}><AtendentesBalcao /></PrivateRoute>} />
      <Route path="/alertas" element={<PrivateRoute roles={ROLE_ROUTES.alertas}><Alertas /></PrivateRoute>} />
      <Route path="/cursos" element={<PrivateRoute roles={ROLE_ROUTES.cursos}><Cursos /></PrivateRoute>} />
      <Route path="/teste-facial-fase-10-3" element={<PrivateRoute roles={ROLE_ROUTES.testeFacialFase103}><TesteFacialFase103 /></PrivateRoute>} />
      <Route path="/" element={<Navigate to="/dashboard" />} />
    </Routes>
  );
}

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          <ErrorBoundary>
            <AppRoutes />
          </ErrorBoundary>
          <Toaster position="top-right" />
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}

export default App;

