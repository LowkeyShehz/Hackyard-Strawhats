import React from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ADMIN_ROLES } from '../utils/roles';
import Layout from './Layout';
import PublicShell from './PublicShell';

/** The verify page sits inside the dashboard for signed-in admins, and stands alone for officers scanning a QR */
export default function VerifyFrame() {
    const { admin } = useAuth();
    if (admin && ADMIN_ROLES.includes(admin.role)) return <Layout />;
    return <PublicShell><Outlet /></PublicShell>;
}
