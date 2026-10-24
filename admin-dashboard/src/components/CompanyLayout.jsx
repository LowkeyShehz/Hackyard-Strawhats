import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    HardHatIcon,
    BarChartIcon,
    UsersIcon,
    FlagIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    MenuIcon,
    CloseIcon,
    LogOutIcon,
} from './Icons';
import useCollapsibleSidebar from '../utils/useCollapsibleSidebar';

const NAV = [
    { to: '/company', end: true, icon: BarChartIcon, label: 'Overview' },
    { to: '/company/roster', icon: UsersIcon, label: "Today's Roster" },
    { to: '/company/flags', icon: FlagIcon, label: 'Flagged Check-ins' },
];

/** Frame for construction-company users: their own sites only, read-only */
export default function CompanyLayout() {
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [isCollapsed, toggleCollapse] = useCollapsibleSidebar('nm_company_sidebar_collapsed');

    const { admin, logout } = useAuth();
    const navigate = useNavigate();

    async function handleLogout() {
        await logout();
        navigate('/login');
    }

    return (
        <div className={`app-layout ${isCollapsed ? 'sidebar--collapsed' : 'sidebar--expanded'}`}>
            <button className="sidebar-toggle" onClick={() => setIsSidebarOpen(!isSidebarOpen)} aria-label="Toggle Sidebar">
                {isSidebarOpen ? <CloseIcon size={20} /> : <MenuIcon size={20} />}
            </button>
            {isSidebarOpen && <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} />}

            <aside className={`sidebar ${isSidebarOpen ? 'open' : ''} ${isCollapsed ? 'collapsed' : ''}`}>
                <div className="sidebar-header">
                    <div className="sidebar-logo">
                        <div className="logo-icon" title="Nirman Mitra">
                            <HardHatIcon size={22} color="#ffffff" />
                        </div>
                        {!isCollapsed && (
                            <div>
                                <h1>Nirman Mitra</h1>
                                <span>Company Dashboard</span>
                            </div>
                        )}
                    </div>
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
                    {NAV.map((item) => {
                        const Icon = item.icon;
                        return (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.end}
                                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                                onClick={() => setIsSidebarOpen(false)}
                                title={isCollapsed ? item.label : undefined}
                            >
                                <span className="icon"><Icon size={18} /></span>
                                {!isCollapsed && <span className="nav-label-text">{item.label}</span>}
                            </NavLink>
                        );
                    })}
                </nav>
                <div style={{ padding: isCollapsed ? '16px 8px' : '16px 20px', borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: isCollapsed ? 'center' : 'space-between', gap: '8px' }}>
                        {!isCollapsed && (
                            <div className="admin-user-details" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                {admin?.company_name || admin?.name || 'Company'}<br />
                                <span style={{ fontSize: '11px', color: 'var(--green-india)' }}>company · view only</span>
                            </div>
                        )}
                        <button
                            className="btn btn-outline btn-sm"
                            onClick={handleLogout}
                            title="Logout"
                            style={{
                                color: 'var(--danger)',
                                padding: isCollapsed ? '6px' : '4px 10px',
                                display: 'flex',
                                alignItems: 'center',
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
                <div className="card" style={{ borderLeft: '4px solid var(--saffron)', marginBottom: '24px', padding: '14px 20px' }}>
                    <p style={{ fontSize: '14px', fontWeight: 600, marginBottom: '2px' }}>View only</p>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Attendance at your sites is verified independently (face, location and voice) and reviewed by
                        the welfare board. Companies can see and export it, but cannot approve, reject or change it.
                    </p>
                </div>
                <Outlet />
            </main>
        </div>
    );
}
