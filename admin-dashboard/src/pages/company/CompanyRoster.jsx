import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { networkErrorMessage } from '../../utils/events';
import { downloadFile } from '../../utils/download';
import { statusBadge, istTime, istToday, shiftDate } from './companyStatus';

export default function CompanyRoster() {
    const [date, setDate] = useState(istToday());
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [muster, setMuster] = useState({ from: shiftDate(istToday(), -6), to: istToday() });
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get(`/api/company/roster?date=${encodeURIComponent(date)}`);
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setData(body);
        } catch (err) {
            setData(null);
            setError(networkErrorMessage(err));
        }
        setLoading(false);
    }, [date]);

    useEffect(() => { load(); }, [load]);

    async function exportMuster(e) {
        e.preventDefault();
        setExporting(true);
        setExportError('');
        try {
            await downloadFile(
                `/api/company/muster.csv?from=${encodeURIComponent(muster.from)}&to=${encodeURIComponent(muster.to)}`,
                `muster-roll-${muster.from}-to-${muster.to}.csv`,
            );
        } catch (err) {
            setExportError(networkErrorMessage(err));
        }
        setExporting(false);
    }

    const rows = data?.rows || [];
    const verified = rows.filter((r) => r.status === 'auto_approved' || r.status === 'approved').length;

    return (
        <div>
            <div className="page-header">
                <h2>Roster</h2>
                <p>Who checked in at your sites, and how each check-in was verified</p>
            </div>

            <div className="card" style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                        Date
                        <input type="date" className="search-input" value={date} max={istToday()} onChange={(e) => setDate(e.target.value)} />
                    </label>
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                        {rows.length} check-in{rows.length === 1 ? '' : 's'} · {verified} verified
                    </span>
                </div>

                {error && <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '12px' }}>Could not load the roster: {error}</p>}

                <div className="table-container">
                    <table>
                        <thead><tr><th>Worker</th><th>Site</th><th>Time</th><th>Status</th><th>Note</th></tr></thead>
                        <tbody>
                            {rows.map((r) => {
                                const badge = statusBadge(r.status);
                                return (
                                    <tr key={`${r.worker_id}-${r.site_id}`}>
                                        <td><strong>{r.worker_name}</strong><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{r.phone}</div></td>
                                        <td>{r.site_name}</td>
                                        <td>{istTime(r.time)}</td>
                                        <td><span className={`badge ${badge.className}`}>{badge.label}</span></td>
                                        <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{r.flag_reason || '-'}</td>
                                    </tr>
                                );
                            })}
                            {!loading && rows.length === 0 && !error && (
                                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No check-ins at your sites on this date.</td></tr>
                            )}
                            {loading && (
                                <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="card">
                <h3 style={{ marginBottom: '8px' }}>Muster roll</h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                    CSV with one row per worker per site and one column per day: P present (verified), R under review,
                    X rejected, - no check-in. Up to 31 days.
                </p>
                <form onSubmit={exportMuster} style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                    <label style={{ fontSize: '14px' }}>
                        From <input type="date" className="search-input" value={muster.from} max={muster.to}
                            onChange={(e) => setMuster((m) => ({ ...m, from: e.target.value }))} />
                    </label>
                    <label style={{ fontSize: '14px' }}>
                        To <input type="date" className="search-input" value={muster.to} min={muster.from} max={istToday()}
                            onChange={(e) => setMuster((m) => ({ ...m, to: e.target.value }))} />
                    </label>
                    <button className="btn btn-primary btn-sm" type="submit" disabled={exporting}>
                        {exporting ? 'Preparing...' : 'Download CSV'}
                    </button>
                </form>
                {exportError && <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginTop: '12px' }}>{exportError}</p>}
            </div>
        </div>
    );
}
