import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { networkErrorMessage } from '../../utils/events';
import { statusBadge, istTime } from './companyStatus';

export default function CompanyFlags() {
    const [days, setDays] = useState(7);
    const [rows, setRows] = useState([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get(`/api/company/flags?days=${days}`);
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setRows(body.rows || []);
        } catch (err) {
            setRows([]);
            setError(networkErrorMessage(err));
        }
        setLoading(false);
    }, [days]);

    useEffect(() => { load(); }, [load]);

    return (
        <div>
            <div className="page-header">
                <h2>Flagged Check-ins</h2>
                <p>Check-ins at your sites that the verification checks flagged. Decisions are made by the welfare board.</p>
            </div>

            <div className="card">
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
                    <label style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        Period
                        <select className="search-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                            <option value={7}>Last 7 days</option>
                            <option value={14}>Last 14 days</option>
                            <option value={30}>Last 30 days</option>
                        </select>
                    </label>
                </div>

                {error && <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '12px' }}>Could not load flags: {error}</p>}

                <div className="table-container">
                    <table>
                        <thead><tr><th>Date</th><th>Worker</th><th>Site</th><th>Reason</th><th>Status</th></tr></thead>
                        <tbody>
                            {rows.map((r) => {
                                const badge = statusBadge(r.status);
                                return (
                                    <tr key={`${r.worker_id}-${r.date}-${r.site_id}`}>
                                        <td>{r.date}<div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{istTime(r.time)}</div></td>
                                        <td><strong>{r.worker_name}</strong><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{r.phone}</div></td>
                                        <td>{r.site_name}</td>
                                        <td style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '320px' }}>{r.flag_reason}</td>
                                        <td><span className={`badge ${badge.className}`}>{badge.label}</span></td>
                                    </tr>
                                );
                            })}
                            {!loading && rows.length === 0 && !error && (
                                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No flagged check-ins in this period.</td></tr>
                            )}
                            {loading && (
                                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
