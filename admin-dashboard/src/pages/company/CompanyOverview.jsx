import React, { useState, useEffect, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import api from '../../utils/api';
import { networkErrorMessage } from '../../utils/events';
import { CameraIcon, UsersIcon, FlagIcon, CertificateIcon } from '../../components/Icons';

const TOOLTIP_STYLE = { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', color: '#1a1a2e' };

export default function CompanyOverview() {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get('/api/company/overview');
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setData(body);
        } catch (err) {
            setError(networkErrorMessage(err));
        }
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    if (loading && !data) return <div style={{ padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

    if (error || !data) {
        return (
            <div className="card" role="alert" style={{ maxWidth: '640px', borderLeft: '4px solid var(--danger)' }}>
                <p style={{ marginBottom: '12px' }}>Could not load your overview: {error}</p>
                <button className="btn btn-outline btn-sm" onClick={load}>Retry</button>
            </div>
        );
    }

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                <div>
                    <h2>Overview</h2>
                    <p>Verified attendance at your {data.sites.length} site{data.sites.length === 1 ? '' : 's'}</p>
                </div>
                <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
            </div>

            <div className="stat-grid">
                <div className="stat-card">
                    <div className="stat-icon attendance" style={{ color: 'var(--green-india)' }}>
                        <CameraIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{data.checkinsToday}</h3><p>Check-ins today ({data.verifiedToday} verified)</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon workers" style={{ color: 'var(--saffron-dark)' }}>
                        <UsersIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{data.workersLast30Days}</h3><p>Workers (last 30 days)</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon reviews" style={{ color: 'var(--danger)' }}>
                        <FlagIcon size={24} />
                    </div>
                    <div className="stat-info"><h3>{data.flaggedLast7Days}</h3><p>Flagged (last 7 days)</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon certificates" style={{ color: 'var(--navy)' }}>
                        <CertificateIcon size={24} />
                    </div>
                    <div className="stat-info">
                        <h3>{data.welfare.eligible}</h3>
                        <p>Eligible for welfare ({data.welfare.closeToEligibility} close)</p>
                    </div>
                </div>
            </div>

            <div className="charts-grid">
                <div className="chart-card">
                    <h3>Check-ins (Last 7 Days)</h3>
                    <ResponsiveContainer width="100%" height={280}>
                        <AreaChart data={data.trend}>
                            <defs>
                                <linearGradient id="companyCheckins" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#ff9933" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#ff9933" stopOpacity={0} />
                                </linearGradient>
                                <linearGradient id="companyVerified" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#138808" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#138808" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                            <XAxis dataKey="day" stroke="#8896a6" fontSize={12} />
                            <YAxis stroke="#8896a6" fontSize={12} allowDecimals={false} />
                            <Tooltip contentStyle={TOOLTIP_STYLE} />
                            <Legend />
                            <Area type="monotone" dataKey="checkins" name="Check-ins" stroke="#ff9933" strokeWidth={2} fill="url(#companyCheckins)" />
                            <Area type="monotone" dataKey="verified" name="Verified" stroke="#138808" strokeWidth={2} fill="url(#companyVerified)" />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>

                <div className="chart-card">
                    <h3>Your Sites</h3>
                    {data.sites.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                            No sites are linked to your company yet. Ask the Nirman Mitra administrator to assign your sites.
                        </p>
                    ) : (
                        <div className="table-container">
                            <table>
                                <thead><tr><th>Site</th><th>Status</th></tr></thead>
                                <tbody>
                                    {data.sites.map((s) => (
                                        <tr key={s.site_id}>
                                            <td><strong>{s.name}</strong><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.site_id}</div></td>
                                            <td><span className={`badge ${s.is_active ? 'active' : 'rejected'}`}>{s.is_active ? 'active' : 'inactive'}</span></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '16px' }}>
                        Welfare eligibility: {data.welfare.threshold} verified days. Workers close to it may need your
                        help collecting documents.
                    </p>
                </div>
            </div>
        </div>
    );
}
