import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import VerifyFrame from './components/VerifyFrame';
import ReviewQueue from './pages/ReviewQueue';
import WorkerSearch from './pages/WorkerSearch';
import CertificateVerify from './pages/CertificateVerify';
import LoginPage from './pages/LoginPage';
import Sites from './pages/Sites';
import CompanyLayout from './components/CompanyLayout';
import CompanyRoster from './pages/company/CompanyRoster';
import CompanyFlags from './pages/company/CompanyFlags';
import { ADMIN_ROLES, COMPANY_ROLES } from './utils/roles';

// Heavy routes are split into their own chunks: Dashboard pulls in recharts,
// LandingPage carries a large amount of markup and CSS.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const CompanyOverview = lazy(() => import('./pages/company/CompanyOverview'));

function PageFallback() {
    return <div style={{ padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;
}

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <Suspense fallback={<PageFallback />}>
                    <Routes>
                        <Route path="/" element={<Navigate to="/home" replace />} />
                        <Route path="home" element={<LandingPage />} />
                        <Route path="login" element={<LoginPage />} />
                        <Route path="verify" element={<VerifyFrame />}>
                            <Route index element={<CertificateVerify />} />
                            <Route path=":hash" element={<CertificateVerify />} />
                        </Route>
                        <Route element={<ProtectedRoute roles={ADMIN_ROLES}><Layout /></ProtectedRoute>}>
                            <Route path="dashboard" element={<Suspense fallback={<PageFallback />}><Dashboard /></Suspense>} />
                            <Route path="review" element={<ReviewQueue />} />
                            <Route path="workers" element={<WorkerSearch />} />
                            <Route path="workers/:id" element={<WorkerSearch />} />
                            <Route path="sites" element={<Sites />} />
                        </Route>
                        <Route path="company" element={<ProtectedRoute roles={COMPANY_ROLES}><CompanyLayout /></ProtectedRoute>}>
                            <Route index element={<Suspense fallback={<PageFallback />}><CompanyOverview /></Suspense>} />
                            <Route path="roster" element={<CompanyRoster />} />
                            <Route path="flags" element={<CompanyFlags />} />
                        </Route>
                    </Routes>
                </Suspense>
            </AuthProvider>
        </BrowserRouter>
    );
}
