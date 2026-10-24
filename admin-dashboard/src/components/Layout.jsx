import React, { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { REVIEW_QUEUE_CHANGED } from '../utils/events';
import {
    HardHatIcon,
    HomeIcon,
    BarChartIcon,
    ClipboardListIcon,
    UsersIcon,
    MapPinIcon,
    QrCodeIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    MenuIcon,
    CloseIcon,
    LogOutIcon,
    WhatsAppIcon,
} from './Icons';
import useCollapsibleSidebar from '../utils/useCollapsibleSidebar';

export default function Layout() {
    const [reviewCount, setReviewCount] = useState(0);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [isCollapsed, toggleCollapse] = useCollapsibleSidebar('nm_sidebar_collapsed');

    const { admin, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const refreshReviewCount = useCallback(() => {
        api.get('/api/admin/review-queue?limit=50')
            .then(res => (res.ok ? res.json() : null))
            .then(data => { if (data) setReviewCount(data.count ?? (data.items || []).length); })
            .catch(() => {});
    }, []);

    // Refresh the badge on every route change...
    useEffect(() => { refreshReviewCount(); }, [location.pathname, refreshReviewCount]);

    // ...and whenever a review action changes the queue
    useEffect(() => {
        window.addEventListener(REVIEW_QUEUE_CHANGED, refreshReviewCount);
        return () => window.removeEventListener(REVIEW_QUEUE_CHANGED, refreshReviewCount);
    }, [refreshReviewCount]);

    const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);

    async function handleLogout() {
        await logout();
        navigate('/login');
    }

    const navItems = [
        { to: '/home', icon: HomeIcon, label: 'Landing Page' },
        { to: '/dashboard', icon: BarChartIcon, label: 'Dashboard' },
        {
            to: '/review',
            icon: ClipboardListIcon,
            label: 'Review Queue',
            badge: reviewCount > 0 ? (reviewCount >= 50 ? '50+' : reviewCount) : null,
        },
        { to: '/workers', icon: UsersIcon, label: 'Workers' },
        { to: '/sites', icon: MapPinIcon, label: 'Sites' },
        { to: '/verify', icon: QrCodeIcon, label: 'Verify Certificate' },
    ];

    return (
        <div className={`app-layout ${isCollapsed ? 'sidebar--collapsed' : 'sidebar--expanded'}`}>
            {/* Mobile Sidebar Toggle */}
            <button className="sidebar-toggle" onClick={toggleSidebar} aria-label="Toggle Sidebar">
                {isSidebarOpen ? <CloseIcon size={20} /> : <MenuIcon size={20} />}
            </button>

            {/* Mobile Backdrop */}
            {isSidebarOpen && (
                <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} />
            )}

            <aside className={`sidebar ${isSidebarOpen ? 'open' : ''} ${isCollapsed ? 'collapsed' : ''}`}>
                <div className="sidebar-header">
                    <div className="sidebar-logo">
                        <div className="logo-icon" title="Nirman Mitra">
                            <HardHatIcon size={22} color="#ffffff" />
                        </div>
                        {!isCollapsed && (
                            <div>
                                <h1>Nirman Mitra</h1>
                                <span>Admin Dashboard</span>
                            </div>
                        )}
                    </div>
                    {/* Desktop Collapse Toggle */}
                    <button
                        className="sidebar-collapse-btn"
                        onClick={toggleCollapse}
                        title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                        aria-label="Toggle Sidebar Collapse"
                    >
                        {isCollapsed ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
                    </button>
                </div>

                <nav className="sidebar-nav">
                    {navItems.map((item) => {
                        const Icon = item.icon;
                        return (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                                onClick={() => setIsSidebarOpen(false)}
                                title={isCollapsed ? item.label : undefined}
                            >
                                <span className="icon">
                                    <Icon size={18} />
                                </span>
                                {!isCollapsed && <span className="nav-label-text">{item.label}</span>}
                                {item.badge && (
                                    <span className="nav-badge">
                                        {isCollapsed ? '' : item.badge}
                                    </span>
                                )}
                            </NavLink>
                        );
                    })}
                </nav>

                <div style={{ padding: isCollapsed ? '16px 8px' : '16px 20px', borderTop: '1px solid var(--border-color)', background: 'linear-gradient(to right, rgba(255,153,51,0.05), rgba(255,255,255,0.05), rgba(19,136,8,0.05))' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: isCollapsed ? 'center' : 'space-between', gap: '8px' }}>
                        {!isCollapsed && (
                            <div className="admin-user-details" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                {admin?.name || 'Admin'}<br />
                                <span style={{ fontSize: '11px', color: 'var(--green-india)', textTransform: 'capitalize' }}>{admin?.role || 'admin'}</span>
                            </div>
                        )}
                        <button
                            onClick={handleLogout}
                            title="Logout"
                            style={{
                                background: 'none',
                                border: '1px solid var(--border-color)',
                                borderRadius: '6px',
                                padding: isCollapsed ? '6px' : '4px 10px',
                                fontSize: '12px',
                                color: 'var(--danger)',
                                cursor: 'pointer',
                                fontFamily: 'var(--font)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '4px',
                            }}
                        >
                            <LogOutIcon size={14} />
                            {!isCollapsed && <span>Logout</span>}
                        </button>
                    </div>
                </div>
            </aside>

            <main className="main-content">
                <div style={{
                    background: 'linear-gradient(135deg, rgba(255,153,51,0.08) 0%, rgba(255,255,255,0.9) 50%, rgba(19,136,8,0.08) 100%)',
                    border: '1px solid rgba(19,136,8,0.2)',
                    borderLeft: '4px solid #ff9933',
                    borderRadius: 'var(--border-radius-sm)',
                    padding: '14px 20px',
                    marginBottom: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '14px',
                }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <WhatsAppIcon size={24} color="#138808" />
                    </span>
                    <div>
                        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
                            Worker experience happens via WhatsApp. Watch the demo video for the full flow.
                        </p>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                            This dashboard is the <strong>admin / welfare officer interface</strong> for managing registrations, reviewing AI-verified attendance, and issuing BOCW certificates.
                        </p>
                    </div>
                </div>
                <Outlet />
            </main>
        </div>
    );
}
