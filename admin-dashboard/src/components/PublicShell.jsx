import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { homeForRole } from '../utils/roles';

/** Page frame for public pages (no admin sidebar): brand bar and a centred content column */
export default function PublicShell({ children }) {
    const { admin } = useAuth();
    const back = admin ? { to: homeForRole(admin.role), label: 'Back to dashboard' } : { to: '/home', label: 'Back to home' };

    return (
        <div className="public-shell">
            <header className="public-shell-bar">
                <Link to="/home" className="public-shell-brand">
                    <img src="/logo-mark.png" alt="" width="36" height="32" />
                    <span>Nirman Mitra</span>
                </Link>
                <div className="public-shell-actions">
                    <span className="public-shell-tag">Welfare Board Verification</span>
                    <Link to={back.to} className="btn btn-outline btn-sm">&larr; {back.label}</Link>
                </div>
            </header>
            <main className="public-shell-main">{children}</main>
        </div>
    );
}
