import React, { useState, useEffect, useCallback } from 'react';
import {
    BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip,
    ResponsiveContainer, Legend, AreaChart, Area, CartesianGrid,
} from 'recharts';
import api from '../utils/api';
import { networkErrorMessage } from '../utils/events';
import { UsersIcon, CameraIcon, ClockIcon, CertificateIcon } from '../components/Icons';

export default function Dashboard() {
    const [stats, setStats] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [confidenceData, setConfidenceData] = useState([]);
    const [dailyLogs, setDailyLogs] = useState([]);
    const [siteData, setSiteData] = useState([]);

    const fetchAll = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get('/api/admin/dashboard');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setStats({
                active_workers: data.activeWorkers ?? 0,
                total_workers: data.totalWorkers ?? 0,
                pending_reviews: data.pendingReviews ?? 0,
                total_days_logged: data.totalDaysLogged ?? 0,
                average_days: data.averageDaysPerWorker ?? 0,
                onboarding_workers: data.onboardingWorkers ?? 0,
                certificate_threshold: typeof data.certificateThreshold === 'number' ? data.certificateThreshold : null,
            });
            // Charts come from the same response; never substitute made-up data
            setDailyLogs(Array.isArray(data.trends) ? data.trends : []);
            setConfidenceData(Array.isArray(data.distribution) ? data.distribution : []);
            setSiteData(Array.isArray(data.sites) ? data.sites : []);
            setLastUpdated(new Date());
        } catch (err) {
            setStats(null);
            setError(networkErrorMessage(err));
        }
        setLoading(false);
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    if (loading && !stats) return <div style={{ padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

    if (error || !stats) {
        return (
            <div>
                <div className="page-header">
                    <h2>Dashboard</h2>
                    <p>Real-time overview of Nirman Mitra platform activity</p>
                </div>
                <div className="card" role="alert" style={{ maxWidth: '640px', borderLeft: '4px solid var(--danger)' }}>
                    <h3 style={{ marginBottom: '8px' }}>Could not load dashboard data</h3>
                    <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>{error || 'Unknown error'}</p>
                    <button className="btn btn-primary btn-sm" onClick={fetchAll} disabled={loading}>
                        {loading ? 'Retrying...' : 'Retry'}
                    </button>
                </div>
            </div>
        );
    }

    const hasDistribution = confidenceData.some(d => (d.value || 0) > 0);

    const SITE_COLORS = ['#138808', '#ff9933', '#000080', '#1a8c38', '#e67e22'];

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <h2>Dashboard</h2>
                    <p>Real-time overview of Nirman Mitra platform activity</p>
                    {lastUpdated && (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                            Last Updated: {lastUpdated.toLocaleTimeString()}
                        </p>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
                        background: 'rgba(19,136,8,0.1)', color: '#138808', border: '1px solid rgba(19,136,8,0.3)',
                    }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#138808', boxShadow: '0 0 6px #138808' }} />
                        Live
                    </span>
                    <button className="btn btn-outline btn-sm" onClick={fetchAll} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
                </div>
            </div>

            <div className="stat-grid">
                <div className="stat-card">
                    <div className="stat-icon workers" style={{ color: 'var(--saffron-dark)' }}>
                        <UsersIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{stats.active_workers}</h3><p>Active Workers</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon attendance" style={{ color: 'var(--green-india)' }}>
                        <CameraIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{stats.total_days_logged}</h3><p>Total Days Logged</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon reviews" style={{ color: 'var(--saffron-dark)' }}>
                        <ClockIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{stats.pending_reviews}</h3><p>Pending Reviews</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon certificates" style={{ color: 'var(--navy)' }}>
                        <CertificateIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{stats.total_workers}</h3><p>Total Registered</p></div>
                </div>
            </div>

            <div className="charts-grid">
                <div className="chart-card">
                    <h3>AI Confidence Distribution</h3>
                    {!hasDistribution ? (
                        <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
                            No attendance logs yet
                        </div>
                    ) : (
                    <ResponsiveContainer width="100%" height={280}>
                        <PieChart>
                            <Pie data={confidenceData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} dataKey="value"
                                label={({ value }) => `${value}%`}>
                                {confidenceData.map((entry, i) => (<Cell key={i} fill={entry.color} />))}
                            </Pie>
                            <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', color: '#1a1a2e' }} />
                            <Legend />
                        </PieChart>
                    </ResponsiveContainer>
                    )}
                </div>

                <div className="chart-card">
                    <h3>Daily Attendance Logs (Last 7 Days)</h3>
                    <ResponsiveContainer width="100%" height={280}>
                        <AreaChart data={dailyLogs}>
                            <defs>
                                <linearGradient id="attendanceGradient" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#138808" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#138808" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                            <XAxis dataKey="day" stroke="#8896a6" fontSize={12} />
                            <YAxis stroke="#8896a6" fontSize={12} />
                            <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', color: '#1a1a2e' }} />
                            <Area type="monotone" dataKey="logs" stroke="#138808" strokeWidth={2}
                                fill="url(#attendanceGradient)" />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {siteData.length > 0 && (
                <div className="charts-grid" style={{ marginTop: '20px' }}>
                    <div className="chart-card">
                        <h3>Attendance by Site</h3>
                        <ResponsiveContainer width="100%" height={280}>
                            <BarChart data={siteData} layout="vertical">
                                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                                <XAxis type="number" stroke="#8896a6" fontSize={12} />
                                <YAxis dataKey="site" type="category" stroke="#8896a6" fontSize={11} width={120} />
                                <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', color: '#1a1a2e' }} />
                                <Bar dataKey="logs" radius={[0, 6, 6, 0]}>
                                    {siteData.map((_, i) => (
                                        <Cell key={i} fill={SITE_COLORS[i % SITE_COLORS.length]} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="chart-card">
                        <h3>Platform Health</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px', padding: '20px 0' }}>
                            <div>
                                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Average Days/Worker</p>
                                <p style={{ fontSize: '28px', fontWeight: 700, color: 'var(--success)' }}>{stats.average_days}</p>
                            </div>
                            <div>
                                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Onboarding</p>
                                <p style={{ fontSize: '28px', fontWeight: 700, color: 'var(--warning)' }}>{stats.onboarding_workers}</p>
                            </div>
                            <div>
                                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Total Registered</p>
                                <p style={{ fontSize: '28px', fontWeight: 700 }}>{stats.total_workers}</p>
                            </div>
                            <div>
                                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{stats.certificate_threshold !== null ? 'Certificate Threshold' : 'Pending Reviews'}</p>
                                <p style={{ fontSize: '28px', fontWeight: 700, color: 'var(--accent-primary)' }}>{stats.certificate_threshold !== null ? `${stats.certificate_threshold} days` : stats.pending_reviews}</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {siteData.length === 0 && (
                <div className="card" style={{ marginTop: '20px' }}>
                    <h3 style={{ marginBottom: '16px' }}>Platform Health</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' }}>
                        <div>
                            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Average Days/Worker</p>
                            <p style={{ fontSize: '24px', fontWeight: 700, color: 'var(--success)' }}>{stats.average_days}</p>
                        </div>
                        <div>
                            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Total Registered</p>
                            <p style={{ fontSize: '24px', fontWeight: 700 }}>{stats.total_workers}</p>
                        </div>
                        <div>
                            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{stats.certificate_threshold !== null ? 'Certificate Threshold' : 'Pending Reviews'}</p>
                            <p style={{ fontSize: '24px', fontWeight: 700, color: 'var(--accent-primary)' }}>{stats.certificate_threshold !== null ? `${stats.certificate_threshold} days` : stats.pending_reviews}</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
